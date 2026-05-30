const express    = require('express');
const mongoose   = require('mongoose');
const bodyParser = require('body-parser');
const cors       = require('cors');
const jwt        = require('jsonwebtoken');
const { festivosLFT, esFestivo } = require('./festivosMX');

const app  = express();
const PORT = process.env.PORT || 8000;
const JWT_SECRET = process.env.JWT_SECRET || 'cambia_esto_en_produccion_123';

app.use(cors());
// Las rutas del checador (/iclock) mandan TEXTO PLANO con las marcaciones.
// Hay que leerlas como texto crudo ANTES de los parsers JSON/urlencoded,
// si no req.body queda como objeto vacio y no se guardan las marcaciones.
app.use('/iclock', bodyParser.text({ type: '*/*' }));
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));
app.use((req, res, next) => {
  if (req.body === undefined) { bodyParser.text({ type: '*/*' })(req, res, next); } else { next(); }
});

mongoose.connect(process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017/asistencia_pwa')
  .then(() => console.log('✅ MongoDB conectado'))
  .catch(err => console.error('❌ MongoDB error:', err));

// ─── Modelos ──────────────────────────────────────────────────────────────────

const RegistroSchema = new mongoose.Schema({
  empleadoId:    { type: String, required: true, index: true },
  fechaHora:     { type: Date,   required: true, index: true },
  sucursal:      { type: String, required: true },
  estadoPunch:   { type: Number, default: 0 },
  tipoEvento:    { type: String, default: 'Entrada', enum: ['Entrada','Salida','Break-Salida','Break-Entrada','Extra-Entrada','Extra-Salida','Desconocido'] },
  tipoRegistro:  { type: String, default: 'Asistencia', enum: ['Asistencia','Enfermedad','Vacaciones','Comisión'] },
  fuente:        { type: String, default: 'agente', enum: ['agente','adms','manual'] },
  numeroSerie:   { type: String, default: '' },
  fechaRegistro: { type: Date,   default: Date.now },
}, { timestamps: true });
RegistroSchema.index({ empleadoId: 1, fechaHora: 1, sucursal: 1 }, { unique: true });
const Registro = mongoose.model('Registro', RegistroSchema);

const HorarioSchema = new mongoose.Schema({
  empleadoId:        { type: String, required: true, unique: true },
  nombre:            { type: String, required: true },
  apellido:          { type: String, default: '' },
  sucursal:          { type: String, default: 'Ameca' },
  activo:            { type: Boolean, default: true },
  horarios: {
    lunes:     { entrada: String, salida: String },
    martes:    { entrada: String, salida: String },
    miercoles: { entrada: String, salida: String },
    jueves:    { entrada: String, salida: String },
    viernes:   { entrada: String, salida: String },
    sabado:    { entrada: String, salida: String },
    domingo:   { entrada: String, salida: String },
  },
  toleranciaMinutos: { type: Number, default: 5 },
  notas:             { type: String, default: '' },
  notasBaja:         { type: String, default: '' },
  fechaBaja:         { type: Date },
}, { timestamps: true });
const Horario = mongoose.model('Horario', HorarioSchema);

// ── Modelo de Festivos (configuración guardada en BD) ─────────────────────────
const FestivoSchema = new mongoose.Schema({
  fecha:       { type: String, required: true, unique: true }, // YYYY-MM-DD
  nombre:      { type: String, required: true },
  tipo:        { type: String, default: 'obligatorio', enum: ['obligatorio','opcional','personalizado'] },
  activo:      { type: Boolean, default: true },              // false = desactivado para este año
  aplica:      { type: String, default: 'ambas', enum: ['ambas','Ameca','Tepetlixpa'] },
  movible:     { type: Boolean, default: false },
  descripcion: { type: String, default: '' },
  creadoEn:    { type: Date, default: Date.now },
});
const Festivo = mongoose.model('Festivo', FestivoSchema);

const SyncLogSchema = new mongoose.Schema({
  sucursal: String, totalLeidos: Number, guardados: Number,
  duplicados: Number, errores: Number, fechaSync: { type: Date, default: Date.now },
});
const SyncLog = mongoose.model('SyncLog', SyncLogSchema);

const HorarioLogSchema = new mongoose.Schema({
  empleadoId:    { type: String, required: true, index: true },
  nombre:        { type: String },
  cambiadoPor:   { type: String, default: 'admin' },
  descripcion:   { type: String },
  valorAnterior: { type: mongoose.Schema.Types.Mixed },
  valorNuevo:    { type: mongoose.Schema.Types.Mixed },
  fecha:         { type: Date, default: Date.now },
});
const HorarioLog = mongoose.model('HorarioLog', HorarioLogSchema);


// ─── Seed festivos para año actual y siguiente ────────────────────────────────
async function seedFestivos() {
  const count = await Festivo.countDocuments();
  if (count > 0) return;
  const anioActual  = new Date().getFullYear();
  const anioSig     = anioActual + 1;
  const todos = [
    ...festivosLFT(anioActual).map(f => ({ ...f, activo: f.tipo === 'obligatorio', aplica: 'ambas' })),
    ...festivosLFT(anioSig).map(f => ({ ...f, activo: f.tipo === 'obligatorio', aplica: 'ambas' })),
  ];
  // Evitar duplicados si ya existen fechas
  for (const f of todos) {
    await Festivo.updateOne({ fecha: f.fecha }, { $setOnInsert: f }, { upsert: true });
  }
  console.log(`✅ Festivos cargados: ${anioActual} y ${anioSig}`);
}
setTimeout(seedFestivos, 4000);

// ─── Seed horarios ────────────────────────────────────────────────────────────
async function seedHorarios() {
  const count = await Horario.countDocuments();
  if (count > 0) return;
  const lv = (e, s) => ({ entrada: e, salida: s });
  const empleados = [
    { empleadoId:'001', nombre:'Esperanza Adriana', apellido:'Vazquez',   sucursal:'Ameca',       horarios:{ lunes:lv('07:00','14:30'), martes:lv('07:00','14:30'), miercoles:lv('07:00','14:30'), jueves:lv('07:00','14:30'), viernes:lv('07:00','14:30'), sabado:lv('07:00','15:30'), domingo:null }},
    { empleadoId:'002', nombre:'Maribel',           apellido:'Quiroz',    sucursal:'Ameca',       horarios:{ lunes:lv('07:00','14:30'), martes:lv('07:00','14:30'), miercoles:lv('07:00','14:30'), jueves:lv('07:00','14:30'), viernes:lv('07:00','14:30'), sabado:null, domingo:lv('07:00','15:30') }},
    { empleadoId:'003', nombre:'Gabriela',          apellido:'Ramirez',   sucursal:'Ameca',       horarios:{ lunes:lv('07:00','14:30'), martes:lv('07:00','14:30'), miercoles:lv('07:00','14:30'), jueves:lv('07:00','14:30'), viernes:lv('07:00','14:30'), sabado:lv('07:00','14:30'), domingo:null }},
    { empleadoId:'004', nombre:'Hannia',            apellido:'Corona',    sucursal:'Ameca',       horarios:{ lunes:lv('08:00','17:00'), martes:lv('08:00','17:00'), miercoles:lv('08:00','17:00'), jueves:lv('08:00','17:00'), viernes:lv('08:00','17:00'), sabado:null, domingo:null }},
    { empleadoId:'005', nombre:'Hector Abraham',    apellido:'Hernandez', sucursal:'Ameca',       horarios:{ lunes:lv('09:00','17:00'), martes:lv('09:00','17:00'), miercoles:lv('09:00','17:00'), jueves:lv('09:00','17:00'), viernes:lv('09:00','17:00'), sabado:lv('09:00','15:30'), domingo:null }},
    { empleadoId:'006', nombre:'Ingrid',            apellido:'Gonzalez',  sucursal:'Tepetlixpa',  horarios:{ lunes:lv('07:30','15:00'), martes:lv('07:30','15:00'), miercoles:lv('07:30','15:00'), jueves:lv('07:30','15:00'), viernes:lv('07:30','15:00'), sabado:lv('07:30','15:30'), domingo:lv('07:30','15:30') }},
    { empleadoId:'007', nombre:'Maritza Patricia',  apellido:'Reyes',     sucursal:'Tepetlixpa',  horarios:{ lunes:lv('08:30','16:00'), martes:lv('08:30','16:00'), miercoles:lv('08:30','16:00'), jueves:null, viernes:lv('08:30','16:00'), sabado:lv('07:00','15:30'), domingo:null }, notas:'Jueves día libre' },
    { empleadoId:'008', nombre:'Luis Brallan',      apellido:'Sanchez',   sucursal:'Tepetlixpa',  horarios:{ lunes:lv('08:00','17:00'), martes:lv('08:00','17:00'), miercoles:lv('08:00','17:00'), jueves:lv('08:00','17:00'), viernes:lv('08:00','17:00'), sabado:lv('08:00','15:30'), domingo:lv('08:00','15:30') }},
    { empleadoId:'4',   nombre:'Zecarlos',          apellido:'Vazquez',   sucursal:'Tepetlixpa',  horarios:{ lunes:lv('08:00','16:00'), martes:lv('08:00','16:00'), miercoles:lv('08:00','16:00'), jueves:lv('08:00','16:00'), viernes:lv('08:00','16:00'), sabado:lv('07:00','15:30'), domingo:lv('07:00','15:30') }},
  ];
  await Horario.insertMany(empleados);
  console.log('✅ Horarios iniciales cargados');
}
setTimeout(seedHorarios, 3000);

// ─── Auth ─────────────────────────────────────────────────────────────────────
const AGENT_KEY = process.env.AGENT_KEY || 'clave_agente_secreta_456';
const IDS_ADMIN = (process.env.IDS_ADMIN || '').split(',').map(s => s.trim()).filter(Boolean);
const mapaSeriesSucursal = {
  [process.env.SN_AMECA      || 'XXXX123A']: 'Ameca',
  [process.env.SN_TEPETLIXPA || 'YYYY456T']: 'Tepetlixpa',
};

const PUNCH_STATE_MAP = { 0:'Entrada', 1:'Salida', 2:'Break-Salida', 3:'Break-Entrada', 4:'Extra-Entrada', 5:'Extra-Salida' };
const DIAS = ['domingo','lunes','martes','miercoles','jueves','viernes','sabado'];

function requireAuth(req, res, next) {
  const token = req.headers.authorization?.replace('Bearer ', '');
  if (!token) return res.status(401).json({ error: 'Token requerido' });
  try { req.user = jwt.verify(token, JWT_SECRET); next(); }
  catch { res.status(401).json({ error: 'Token inválido o expirado' }); }
}
function requireAgentKey(req, res, next) {
  if (req.headers['x-agent-key'] !== AGENT_KEY) return res.status(401).json({ error: 'Clave inválida' });
  next();
}

function horaAMinutos(str) {
  if (!str) return null;
  const [h, m] = str.split(':').map(Number);
  return h * 60 + m;
}

function getHorarioDia(horario, fecha) {
  const dia = DIAS[new Date(fecha).getDay()];
  return horario.horarios?.[dia] || null;
}

function calcularEstatus(fechaHora, horarioDia, toleranciaMinutos = 5) {
  if (!horarioDia?.entrada) return 'dia_libre';
  const d = new Date(fechaHora);
  const minFichada = d.getHours() * 60 + d.getMinutes();
  const minEntrada = horaAMinutos(horarioDia.entrada);
  if (minEntrada === null) return 'dia_libre';
  return minFichada <= minEntrada + toleranciaMinutos ? 'a_tiempo' : 'retardo';
}

// ─── Rutas Públicas ───────────────────────────────────────────────────────────
app.get('/', (req, res) => res.json({ ok:true, sistema:'Asistencia PWA v5 — con festivos MX', ts:new Date() }));

app.post('/api/auth/login', (req, res) => {
  const { usuario, password } = req.body;
  if (usuario !== (process.env.AUTH_USER||'admin') || password !== (process.env.AUTH_PASS||'admin123')) {
    return res.status(401).json({ error: 'Credenciales incorrectas' });
  }
  const token = jwt.sign({ usuario, role:'admin' }, JWT_SECRET, { expiresIn:'30d' });
  res.json({ token, usuario });
});

// ─── ADMS ─────────────────────────────────────────────────────────────────────
app.get('/iclock/cdata', (req, res) => {
  const sn = req.query.SN || '';
  // Handshake inicial: el checador espera recibir su configuracion
  console.log('[ADMS] Handshake del equipo SN:', sn);
  res.status(200).send(`GET OPTION FROM: ${sn}\nStamp=9999\nOpStamp=9999\nErrorDelay=30\nDelay=30\nTransTimes=00:00;14:05\nTransInterval=1\nTransFlag=1111000000\nRealtime=1\nEncrypt=0\n`);
});
app.post('/iclock/cdata', async (req, res) => {
  const sn = req.query.SN || '';
  const sucursal = mapaSeriesSucursal[sn] || 'Desconocida';
  const tabla = req.query.table || '';
  if (tabla && tabla !== 'ATTLOG') return res.status(200).send('OK');
  const contenido = typeof req.body === 'string' ? req.body : '';
  let guardados = 0, duplicados = 0;
  for (const linea of contenido.split('\n').filter(l => l.trim())) {
    let empleadoId, fechaHoraStr, estadoPunch = 0;
    if (linea.includes('\t')) {
      const p = linea.trim().split('\t');
      empleadoId = p[0]?.trim(); fechaHoraStr = p[1]?.trim(); estadoPunch = parseInt(p[2]?.trim()||'0');
    } else if (linea.includes('PIN=')) {
      empleadoId = linea.match(/PIN=(\S+)/)?.[1];
      fechaHoraStr = linea.match(/DateTime=([^\t\n]+?)(?:\s+\w+=|$)/)?.[1]?.trim();
      estadoPunch = parseInt(linea.match(/Status=(\d+)/)?.[1]||'0');
    } else continue;
    if (!empleadoId || !fechaHoraStr || IDS_ADMIN.includes(empleadoId)) continue;
    const fechaHora = new Date(fechaHoraStr.replace(' ','T'));
    if (isNaN(fechaHora)) continue;
    try {
      await Registro.create({ empleadoId, fechaHora, sucursal, estadoPunch, tipoEvento: PUNCH_STATE_MAP[estadoPunch]||'Desconocido', fuente:'adms', numeroSerie:sn });
      guardados++;
    } catch(e) { if (e.code === 11000) duplicados++; else console.error('[ADMS]', e.message); }
  }
  if (guardados || duplicados) console.log(`[ADMS] ${sucursal} (SN ${sn}): ${guardados} nuevos, ${duplicados} duplicados`);
  res.status(200).send('OK');
});
// El checador pregunta periodicamente si hay comandos pendientes (getrequest).
// Normalmente respondemos OK. Pero si hay un reenvio de historial pendiente,
// le mandamos el comando para que vuelva a subir TODAS sus marcaciones.
const reenvioPendiente = {}; // { 'NUMERO_SERIE': true }
const horaPendiente   = {}; // { 'NUMERO_SERIE': true } -> ajustar reloj

// Hora actual del centro de Mexico (UTC-6, sin horario de verano desde 2023).
function horaMexico() {
  const ahora = new Date();
  // ahora es UTC. Restamos 6 horas para hora del centro de Mexico.
  return new Date(ahora.getTime() - 6 * 60 * 60 * 1000);
}

// El ZKTeco codifica la fecha/hora en un entero con esta formula oficial:
// ((anio-2000)*12*31 + (mes-1)*31 + (dia-1)) * (24*60*60)
//   + hora*3600 + minuto*60 + segundo
// Recibe un Date cuyos componentes UTC ya representan la hora local deseada.
function encodearHoraZK(d) {
  const Y = d.getUTCFullYear(), Mo = d.getUTCMonth()+1, Da = d.getUTCDate();
  const H = d.getUTCHours(), Mi = d.getUTCMinutes(), S = d.getUTCSeconds();
  return ((Y-2000)*12*31 + (Mo-1)*31 + (Da-1)) * 86400 + H*3600 + Mi*60 + S;
}

app.get('/iclock/getrequest', (req, res) => {
  const sn = req.query.SN || '';
  // Comando pendiente para ajustar la hora del checador
  if (horaPendiente[sn]) {
    horaPendiente[sn] = false;
    const id = Date.now();
    const enc = encodearHoraZK(horaMexico());
    const cmd = `C:${id}:SET OPTIONS DateTime=${enc}`;
    console.log('[ADMS] Ajustando hora del equipo SN ' + sn + ' -> ' + horaMexico().toISOString().replace('T',' ').slice(0,19) + ' (hora MX)');
    return res.status(200).send(cmd + '\n');
  }
  if (reenvioPendiente[sn]) {
    reenvioPendiente[sn] = false; // solo una vez
    const id = Date.now();
    const cmd = `C:${id}:DATA QUERY ATTLOG StartTime=2020-01-01 00:00:00\tEndTime=2035-12-31 23:59:59`;
    console.log('[ADMS] Ordenando reenvio de historial a SN:', sn);
    return res.status(200).send(cmd + '\n');
  }
  res.status(200).send('OK');
});
app.post('/iclock/getrequest', (req, res) => res.status(200).send('OK'));
app.get('/iclock/devicecmd', (req, res) => res.status(200).send('OK'));
app.post('/iclock/devicecmd', (req, res) => {
  // El checador reporta el resultado del comando. Solo confirmamos.
  console.log('[ADMS] Equipo confirmo comando:', (typeof req.body === 'string' ? req.body : '').slice(0, 120));
  res.status(200).send('OK');
});

// Boton para forzar el reenvio del historial. Se abre en el navegador:
//   .../api/forzar-historial          -> todos los equipos conocidos
//   .../api/forzar-historial?SN=XXXX   -> solo ese equipo
app.get('/api/forzar-historial', (req, res) => {
  const sn = (req.query.SN || '').trim();
  if (sn) {
    reenvioPendiente[sn] = true;
    return res.json({ ok:true, mensaje:'En unos segundos el equipo '+sn+' reenviara todo su historial. Revisa los Deploy Logs.' });
  }
  const equipos = Object.keys(mapaSeriesSucursal);
  equipos.forEach(s => { reenvioPendiente[s] = true; });
  res.json({ ok:true, mensaje:'En unos segundos los equipos reenviaran su historial. Revisa los Deploy Logs.', equipos });
});

// Boton para ajustar la HORA del checador (hora del centro de Mexico, UTC-6).
// Se abre en el navegador:
//   .../api/ajustar-hora          -> todos los equipos conocidos
//   .../api/ajustar-hora?SN=XXXX   -> solo ese equipo
app.get('/api/ajustar-hora', (req, res) => {
  const sn = (req.query.SN || '').trim();
  const ahora = horaMexico().toISOString().replace('T',' ').slice(0,19);
  if (sn) {
    horaPendiente[sn] = true;
    return res.json({ ok:true, mensaje:'En unos segundos el equipo '+sn+' ajustara su reloj a '+ahora+' (hora MX). Marca una huella para que conecte y aplique.' });
  }
  const equipos = Object.keys(mapaSeriesSucursal);
  equipos.forEach(s => { horaPendiente[s] = true; });
  res.json({ ok:true, mensaje:'En unos segundos los equipos ajustaran su reloj a '+ahora+' (hora MX). Marca una huella en cada uno para que conecten y apliquen.', equipos });
});

app.post('/api/sync', requireAgentKey, async (req, res) => {
  const { registros, sucursal, agentVersion } = req.body;
  if (!Array.isArray(registros)||!sucursal) return res.status(400).json({ error:'Faltan campos' });
  let guardados=0, duplicados=0, errores=0;
  for (const r of registros) {
    const estadoPunch = parseInt(r.estadoPunch??r.type??0);
    try {
      await Registro.create({ empleadoId:String(r.empleadoId), fechaHora:new Date(r.fechaHora), sucursal, estadoPunch, tipoEvento:PUNCH_STATE_MAP[estadoPunch]||'Desconocido', fuente:'agente', numeroSerie:r.numeroSerie||'' });
      guardados++;
    } catch(e) { if (e.code===11000) duplicados++; else errores++; }
  }
  await SyncLog.create({ sucursal, totalLeidos:registros.length, guardados, duplicados, errores, agentVersion });
  res.json({ ok:true, guardados, duplicados, errores });
});

// Renombrar el empleadoId de registros viejos. Util cuando alguien marcaba
// con un id corto (ej "8") y ahora usa el id correcto (ej "008").
// Se abre en el navegador:
//   .../api/renombrar-id?de=8&a=008
// Maneja choques con el indice unico: si ya existe un registro identico con
// el id nuevo (misma fecha/hora/sucursal), borra el viejo duplicado.
app.get('/api/renombrar-id', async (req, res) => {
  const de = (req.query.de || '').trim();
  const a  = (req.query.a  || '').trim();
  if (!de || !a) return res.status(400).json({ ok:false, error:'Faltan parametros. Usa ?de=8&a=008' });

  const viejos = await Registro.find({ empleadoId: de }).lean();
  let renombrados = 0, duplicadosBorrados = 0, errores = 0;

  for (const r of viejos) {
    try {
      // Intentar mover el registro al id nuevo
      await Registro.updateOne({ _id: r._id }, { $set: { empleadoId: a } });
      renombrados++;
    } catch (e) {
      if (e.code === 11000) {
        // Ya existe un registro identico con el id nuevo: borrar el viejo
        try { await Registro.deleteOne({ _id: r._id }); duplicadosBorrados++; }
        catch (e2) { errores++; }
      } else { errores++; }
    }
  }

  console.log(`[RENOMBRAR] ${de} -> ${a}: ${renombrados} movidos, ${duplicadosBorrados} duplicados borrados, ${errores} errores`);
  res.json({ ok:true, de, a, encontrados: viejos.length, renombrados, duplicadosBorrados, errores });
});

// ─── API Festivos ─────────────────────────────────────────────────────────────

// GET todos los festivos (opcionalmente por año)
app.get('/api/festivos', requireAuth, async (req, res) => {
  try {
    const { anio } = req.query;
    const filter = {};
    if (anio) {
      filter.fecha = { $gte:`${anio}-01-01`, $lte:`${anio}-12-31` };
    }
    const festivos = await Festivo.find(filter).sort({ fecha: 1 }).lean();

    // Si se pide un año y no hay festivos, generarlos automáticamente
    if (anio && festivos.length === 0) {
      const generados = festivosLFT(parseInt(anio)).map(f => ({
        ...f, activo: f.tipo === 'obligatorio', aplica: 'ambas',
      }));
      for (const f of generados) {
        await Festivo.updateOne({ fecha: f.fecha }, { $setOnInsert: f }, { upsert: true });
      }
      const nuevos = await Festivo.find(filter).sort({ fecha: 1 }).lean();
      return res.json({ ok: true, data: nuevos, generados: true });
    }

    res.json({ ok: true, data: festivos });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// PUT — activar/desactivar o editar un festivo
app.put('/api/festivos/:id', requireAuth, async (req, res) => {
  try {
    const f = await Festivo.findByIdAndUpdate(req.params.id, { $set: req.body }, { new: true });
    res.json({ ok: true, data: f });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// POST — agregar festivo personalizado
app.post('/api/festivos', requireAuth, async (req, res) => {
  try {
    const { fecha, nombre, aplica } = req.body;
    if (!fecha || !nombre) return res.status(400).json({ error:'fecha y nombre requeridos' });
    const f = await Festivo.create({ fecha, nombre, tipo:'personalizado', activo:true, aplica:aplica||'ambas' });
    res.status(201).json({ ok: true, data: f });
  } catch(e) {
    if (e.code === 11000) return res.status(409).json({ error:'Ya existe un festivo en esa fecha' });
    res.status(500).json({ error: e.message });
  }
});

// DELETE — eliminar festivo personalizado
app.delete('/api/festivos/:id', requireAuth, async (req, res) => {
  try {
    const f = await Festivo.findById(req.params.id);
    if (!f) return res.status(404).json({ error:'No encontrado' });
    if (f.tipo !== 'personalizado') return res.status(400).json({ error:'Solo se pueden eliminar festivos personalizados. Los LFT se desactivan.' });
    await f.deleteOne();
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ─── API Registros ────────────────────────────────────────────────────────────
app.get('/api/registros', requireAuth, async (req, res) => {
  try {
    const { sucursal, fecha, empleadoId, page=1, limit=200 } = req.query;
    const filter = {};
    if (sucursal && sucursal!=='Todas') filter.sucursal = sucursal;
    if (empleadoId) filter.empleadoId = new RegExp(empleadoId,'i');
    if (fecha) filter.fechaHora = { $gte:new Date(fecha+'T00:00:00'), $lte:new Date(fecha+'T23:59:59') };
    const [data, total] = await Promise.all([
      Registro.find(filter).sort({ fechaHora:-1 }).skip((page-1)*Number(limit)).limit(Number(limit)).lean(),
      Registro.countDocuments(filter),
    ]);
    res.json({ ok:true, data, total });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ─── API Resumen con festivos ─────────────────────────────────────────────────
app.get('/api/resumen', requireAuth, async (req, res) => {
  try {
    const { mes, anio, sucursal } = req.query;
    const now = new Date();
    const y   = parseInt(anio || now.getFullYear());
    const m   = parseInt(mes  || now.getMonth()+1) - 1;
    const inicio = new Date(y, m, 1);
    const fin    = new Date(y, m+1, 0, 23, 59, 59);

    const filtroSuc = sucursal && sucursal!=='Todas' ? { sucursal } : {};

    // Cargar festivos activos del mes
    const mesStr = String(m+1).padStart(2,'0');
    const festivosActivos = await Festivo.find({
      fecha: { $gte:`${y}-${mesStr}-01`, $lte:`${y}-${mesStr}-31` },
      activo: true,
    }).lean();

    // Mapa rápido fecha → festivo
    const mapaFestivos = {};
    for (const f of festivosActivos) {
      if (!f.aplica || f.aplica === 'ambas' || !sucursal || sucursal === 'Todas' || f.aplica === sucursal) {
        mapaFestivos[f.fecha] = f;
      }
    }

    const [registros, horarios] = await Promise.all([
      Registro.find({ fechaHora:{ $gte:inicio, $lte:fin }, tipoRegistro:'Asistencia' }).sort({ fechaHora:1 }).lean(),
      Horario.find({ activo:true }).lean(),
    ]);

    // Mapa empleadoId -> sucursal del empleado (segun su horario).
    // Asi un empleado se evalua por SU sucursal, sin importar en cual
    // checador marco fisicamente (puede marcar entrada en una y salida en otra).
    const sucursalDeEmpleado = {};
    for (const h of horarios) sucursalDeEmpleado[h.empleadoId] = h.sucursal;

    // Agrupar registros por empleadoId + fecha
    const regPorEmpleadoDia = {};
    for (const r of registros) {
      const d = new Date(r.fechaHora);
      const fk = `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
      const key = `${r.empleadoId}_${fk}`;
      if (!regPorEmpleadoDia[key]) regPorEmpleadoDia[key] = [];
      regPorEmpleadoDia[key].push(r);
    }

    // Si se filtra por sucursal, filtrar EMPLEADOS por su sucursal de casa,
    // no los registros por donde marcaron.
    const horariosFiltrados = (sucursal && sucursal!=='Todas')
      ? horarios.filter(h => h.sucursal === sucursal)
      : horarios;

    const resumen = [];
    for (const h of horarios) {
      let aTiempo=0, retardos=0, faltas=0, diasLibres=0, diasFestivos=0, totalMinutos=0;
      const detalleDias = [];

      for (let day=1; day<=fin.getDate(); day++) {
        const fecha  = new Date(y, m, day);
        if (fecha > now) break;
        const fechaStr = `${y}-${String(m+1).padStart(2,'0')}-${String(day).padStart(2,'0')}`;

        // ── PRIMERO verificar si es festivo activo ─────────────────────────
        const festivo = mapaFestivos[fechaStr];
        if (festivo) {
          diasFestivos++;
          detalleDias.push({ fecha:fechaStr, estatus:'festivo', nombreFestivo:festivo.nombre, tipo:festivo.tipo });
          continue;
        }

        const horarioDia = getHorarioDia(h, fecha);
        const key = `${h.empleadoId}_${fechaStr}`;
        const regsDelDia = regPorEmpleadoDia[key] || [];

        if (!horarioDia?.entrada) {
          diasLibres++;
          detalleDias.push({ fecha:fechaStr, estatus:'libre' });
          continue;
        }

        if (regsDelDia.length === 0) {
          faltas++;
          detalleDias.push({ fecha:fechaStr, estatus:'falta' });
          continue;
        }

        // Lógica entrada/salida
        const entradas = regsDelDia.filter(r => [0,4].includes(r.estadoPunch));
        const salidas  = regsDelDia.filter(r => [1,5].includes(r.estadoPunch));

        let primeraEntrada = entradas.length > 0
          ? entradas.reduce((a,b) => new Date(a.fechaHora)<new Date(b.fechaHora)?a:b)
          : regsDelDia.reduce((a,b) => new Date(a.fechaHora)<new Date(b.fechaHora)?a:b);

        let ultimaSalida = salidas.length > 0
          ? salidas.reduce((a,b) => new Date(a.fechaHora)>new Date(b.fechaHora)?a:b)
          : regsDelDia.length > 1 ? regsDelDia.reduce((a,b) => new Date(a.fechaHora)>new Date(b.fechaHora)?a:b) : null;

        const estatus = calcularEstatus(primeraEntrada.fechaHora, horarioDia, h.toleranciaMinutos);
        if (estatus === 'retardo') retardos++; else aTiempo++;

        let horasTrabajadas = null;
        if (ultimaSalida && new Date(ultimaSalida.fechaHora) > new Date(primeraEntrada.fechaHora)) {
          const mins = Math.round((new Date(ultimaSalida.fechaHora) - new Date(primeraEntrada.fechaHora)) / 60000);
          totalMinutos += mins;
          horasTrabajadas = `${Math.floor(mins/60)}h ${mins%60}m`;
        }

        let salidaTemprana = false;
        if (ultimaSalida && horarioDia.salida) {
          const d2 = new Date(ultimaSalida.fechaHora);
          salidaTemprana = (d2.getHours()*60+d2.getMinutes()) < (horaAMinutos(horarioDia.salida)-5);
        }

        detalleDias.push({
          fecha: fechaStr, estatus,
          horaEntrada:  primeraEntrada ? new Date(primeraEntrada.fechaHora).toLocaleTimeString('es-MX',{hour:'2-digit',minute:'2-digit',hour12:true}) : null,
          horaSalida:   ultimaSalida   ? new Date(ultimaSalida.fechaHora).toLocaleTimeString('es-MX',{hour:'2-digit',minute:'2-digit',hour12:true}) : null,
          horasTrabajadas, salidaTemprana, totalFichadas: regsDelDia.length,
        });
      }

      const totalDias = aTiempo + retardos + faltas;
      const hh = Math.floor(totalMinutos/60);
      const mm = totalMinutos % 60;

      resumen.push({
        empleadoId: h.empleadoId, nombre:`${h.nombre} ${h.apellido}`.trim(), sucursal: h.sucursal,
        aTiempo, retardos, faltas, diasLibres, diasFestivos, total:totalDias,
        puntualidad: totalDias>0 ? Math.round((aTiempo/totalDias)*100) : 100,
        horasTotales: totalMinutos>0 ? `${hh}h ${mm}m` : null,
        detalleDias,
      });
    }

    resumen.sort((a,b) => b.faltas-a.faltas || b.retardos-a.retardos);
    res.json({ ok:true, data:resumen, mes:m+1, anio:y, festivosActivos:Object.values(mapaFestivos) });
  } catch(e) {
    console.error('[RESUMEN]', e);
    res.status(500).json({ error: e.message });
  }
});

// ─── API Empleados (alta / baja) ──────────────────────────────────────────────

// GET — todos (activos e inactivos)
app.get('/api/empleados', requireAuth, async (req, res) => {
  const { incluirBajas } = req.query;
  const filter = incluirBajas === '1' ? {} : { activo: true };
  const empleados = await Horario.find(filter).sort({ activo:-1, empleadoId:1 }).lean();
  res.json({ ok: true, data: empleados });
});

// POST — dar de alta un empleado nuevo
app.post('/api/empleados', requireAuth, async (req, res) => {
  try {
    const { empleadoId, nombre, apellido, sucursal, horarios, toleranciaMinutos, notas } = req.body;
    if (!empleadoId?.trim() || !nombre?.trim() || !sucursal) {
      return res.status(400).json({ error: 'empleadoId, nombre y sucursal son requeridos' });
    }
    // Verificar que el ID no exista ya
    const existe = await Horario.findOne({ empleadoId: empleadoId.trim() });
    if (existe) {
      return res.status(409).json({ error: `Ya existe un empleado con ID "${empleadoId.trim()}"` });
    }
    const nuevo = await Horario.create({
      empleadoId:        empleadoId.trim(),
      nombre:            nombre.trim(),
      apellido:          apellido?.trim() || '',
      sucursal,
      activo:            true,
      horarios:          horarios || {},
      toleranciaMinutos: toleranciaMinutos || 5,
      notas:             notas || '',
    });
    console.log(`[EMPLEADOS] ✅ Alta: ${nuevo.nombre} ${nuevo.apellido} (ID: ${nuevo.empleadoId})`);
    res.status(201).json({ ok: true, data: nuevo });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// PATCH /api/empleados/:id/baja — dar de baja (inactivar)
app.patch('/api/empleados/:empleadoId/baja', requireAuth, async (req, res) => {
  try {
    const { motivo, fechaBaja } = req.body;
    const h = await Horario.findOneAndUpdate(
      { empleadoId: req.params.empleadoId },
      { $set: { activo: false, notasBaja: motivo || '', fechaBaja: fechaBaja ? new Date(fechaBaja) : new Date() } },
      { new: true }
    );
    if (!h) return res.status(404).json({ error: 'Empleado no encontrado' });
    console.log(`[EMPLEADOS] 🔴 Baja: ${h.nombre} ${h.apellido} (ID: ${h.empleadoId}) — ${motivo||'sin motivo'}`);
    res.json({ ok: true, data: h });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// PATCH /api/empleados/:id/reactivar — reactivar empleado dado de baja
app.patch('/api/empleados/:empleadoId/reactivar', requireAuth, async (req, res) => {
  try {
    const h = await Horario.findOneAndUpdate(
      { empleadoId: req.params.empleadoId },
      { $set: { activo: true }, $unset: { notasBaja: '', fechaBaja: '' } },
      { new: true }
    );
    if (!h) return res.status(404).json({ error: 'Empleado no encontrado' });
    console.log(`[EMPLEADOS] ✅ Reactivado: ${h.nombre} (ID: ${h.empleadoId})`);
    res.json({ ok: true, data: h });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── API Horarios ─────────────────────────────────────────────────────────────
app.get('/api/horarios', requireAuth, async (req, res) => {
  const horarios = await Horario.find({ activo:true }).sort({ empleadoId:1 }).lean();
  res.json({ ok:true, data:horarios });
});
app.put('/api/horarios/:empleadoId', requireAuth, async (req, res) => {
  try {
    const anterior = await Horario.findOne({ empleadoId: req.params.empleadoId }).lean();
    const h = await Horario.findOneAndUpdate({ empleadoId:req.params.empleadoId }, { $set:req.body }, { new:true, upsert:true });

    // Registrar cambio en el log
    const cambios = [];
    if (req.body.horarios) cambios.push('horarios');
    if (req.body.toleranciaMinutos !== undefined) cambios.push('toleranciaMinutos');
    if (req.body.sucursal) cambios.push('sucursal');
    if (req.body.notas !== undefined) cambios.push('notas');

    if (cambios.length > 0 && anterior) {
      await HorarioLog.create({
        empleadoId:    req.params.empleadoId,
        nombre:        h.nombre + ' ' + h.apellido,
        cambiadoPor:   req.user?.usuario || 'admin',
        descripcion:   `Modificó: ${cambios.join(', ')}`,
        valorAnterior: Object.fromEntries(cambios.map(c => [c, anterior[c]])),
        valorNuevo:    Object.fromEntries(cambios.map(c => [c, req.body[c]])),
      });
    }

    res.json({ ok:true, data:h });
  } catch(e) { res.status(500).json({ error:e.message }); }
});

// ─── API Stats ────────────────────────────────────────────────────────────────
app.get('/api/stats', requireAuth, async (req, res) => {
  try {
    const hoyI = new Date(); hoyI.setHours(0,0,0,0);
    const hoyF = new Date(); hoyF.setHours(23,59,59,999);
    const hoy = new Date();
    const fechaHoyStr = `${hoy.getFullYear()}-${String(hoy.getMonth()+1).padStart(2,'0')}-${String(hoy.getDate()).padStart(2,'0')}`;

    const [total, hoyCount, ameca, tepetlixpa, ultimoSync, entradas, salidas, festivoHoy] = await Promise.all([
      Registro.countDocuments(),
      Registro.countDocuments({ fechaHora:{ $gte:hoyI, $lte:hoyF } }),
      Registro.countDocuments({ sucursal:'Ameca' }),
      Registro.countDocuments({ sucursal:'Tepetlixpa' }),
      SyncLog.findOne().sort({ fechaSync:-1 }).lean(),
      Registro.countDocuments({ fechaHora:{ $gte:hoyI, $lte:hoyF }, estadoPunch:0 }),
      Registro.countDocuments({ fechaHora:{ $gte:hoyI, $lte:hoyF }, estadoPunch:1 }),
      Festivo.findOne({ fecha:fechaHoyStr, activo:true }).lean(),
    ]);

    res.json({ ok:true, total, hoy:hoyCount, ameca, tepetlixpa, ultimoSync,
      entradasHoy:entradas, salidasHoy:salidas, festivoHoy });
  } catch(e) { res.status(500).json({ error:e.message }); }
});

app.post('/api/registros/manual', requireAuth, async (req, res) => {
  try {
    const { empleadoId, sucursal, tipoRegistro } = req.body;
    if (!empleadoId||!sucursal||!tipoRegistro) return res.status(400).json({ error:'Faltan campos' });
    const r = await Registro.create({ empleadoId:empleadoId.trim(), fechaHora:new Date(), sucursal, tipoRegistro, estadoPunch:0, tipoEvento:'Entrada', fuente:'manual', numeroSerie:'MANUAL' });
    res.status(201).json({ ok:true, data:r });
  } catch(e) { res.status(500).json({ error:e.message }); }
});

app.get('/api/sync/logs', requireAuth, async (req, res) => {
  const logs = await SyncLog.find().sort({ fechaSync:-1 }).limit(20).lean();
  res.json({ ok:true, data:logs });
});


// ─── API Log de cambios de horario ───────────────────────────────────────────
app.get('/api/horarios/logs', requireAuth, async (req, res) => {
  try {
    const { empleadoId } = req.query;
    const filter = empleadoId ? { empleadoId } : {};
    const logs = await HorarioLog.find(filter).sort({ fecha: -1 }).limit(50).lean();
    res.json({ ok: true, data: logs });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ─── API Reporte mensual ──────────────────────────────────────────────────────
app.get('/api/reporte', requireAuth, async (req, res) => {
  try {
    const { mes, anio, sucursal } = req.query;
    const now = new Date();
    const y   = parseInt(anio || now.getFullYear());
    const m   = parseInt(mes  || now.getMonth() + 1) - 1;
    const inicio = new Date(y, m, 1);
    const fin    = new Date(y, m + 1, 0, 23, 59, 59);

    const filtroSuc = sucursal && sucursal !== 'Todas' ? { sucursal } : {};
    const mesStr = String(m+1).padStart(2,'0');
    const festivosActivos = await Festivo.find({
      fecha: { $gte:`${y}-${mesStr}-01`, $lte:`${y}-${mesStr}-31` },
      activo: true,
    }).lean();
    const mapaFestivos = {};
    for (const f of festivosActivos) {
      if (!f.aplica || f.aplica === 'ambas' || !sucursal || sucursal === 'Todas' || f.aplica === sucursal) {
        mapaFestivos[f.fecha] = f;
      }
    }

    const [registros, horarios] = await Promise.all([
      Registro.find({ fechaHora:{ $gte:inicio, $lte:fin }, tipoRegistro:'Asistencia', ...filtroSuc }).sort({ fechaHora:1 }).lean(),
      Horario.find({ activo:true }).lean(),
    ]);

    const regPorEmpleadoDia = {};
    for (const r of registros) {
      const d = new Date(r.fechaHora);
      const fk = `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
      const key = `${r.empleadoId}_${fk}`;
      if (!regPorEmpleadoDia[key]) regPorEmpleadoDia[key] = [];
      regPorEmpleadoDia[key].push(r);
    }

    const DIAS = ['domingo','lunes','martes','miercoles','jueves','viernes','sabado'];
    function horaAMinutos(str) { if (!str) return null; const [h,m]=str.split(':').map(Number); return h*60+m; }
    function getHorarioDia(h, fecha) { return h.horarios?.[DIAS[new Date(fecha).getDay()]] || null; }

    const reporte = [];
    for (const h of horarios) {
      if (filtroSuc.sucursal && h.sucursal !== filtroSuc.sucursal) continue;
      let aTiempo=0, retardos=0, faltas=0, diasLibres=0, diasFestivos=0, totalMinutos=0;
      const detalle = [];

      for (let day=1; day<=fin.getDate(); day++) {
        const fecha = new Date(y, m, day);
        if (fecha > now) break;
        const fechaStr = `${y}-${String(m+1).padStart(2,'0')}-${String(day).padStart(2,'0')}`;
        if (mapaFestivos[fechaStr]) { diasFestivos++; detalle.push({ fecha:fechaStr, estatus:'festivo', nombre:mapaFestivos[fechaStr].nombre }); continue; }
        const horarioDia = getHorarioDia(h, fecha);
        if (!horarioDia?.entrada) { diasLibres++; detalle.push({ fecha:fechaStr, estatus:'libre' }); continue; }
        const regsDelDia = regPorEmpleadoDia[`${h.empleadoId}_${fechaStr}`] || [];
        if (regsDelDia.length === 0) { faltas++; detalle.push({ fecha:fechaStr, estatus:'falta' }); continue; }
        const entradas = regsDelDia.filter(r=>[0,4].includes(r.estadoPunch));
        const salidas  = regsDelDia.filter(r=>[1,5].includes(r.estadoPunch));
        const entrada = entradas.length>0 ? entradas.reduce((a,b)=>new Date(a.fechaHora)<new Date(b.fechaHora)?a:b) : regsDelDia.reduce((a,b)=>new Date(a.fechaHora)<new Date(b.fechaHora)?a:b);
        const salida  = salidas.length>0  ? salidas.reduce((a,b)=>new Date(a.fechaHora)>new Date(b.fechaHora)?a:b) : regsDelDia.length>1 ? regsDelDia.reduce((a,b)=>new Date(a.fechaHora)>new Date(b.fechaHora)?a:b) : null;
        const minFichada = new Date(entrada.fechaHora);
        const minEntrada = horaAMinutos(horarioDia.entrada);
        const minReal    = minFichada.getHours()*60 + minFichada.getMinutes();
        const estatus    = minReal <= minEntrada + (h.toleranciaMinutos||5) ? 'a_tiempo' : 'retardo';
        if (estatus==='retardo') retardos++; else aTiempo++;
        let mins = null;
        if (salida && new Date(salida.fechaHora) > new Date(entrada.fechaHora)) {
          mins = Math.round((new Date(salida.fechaHora)-new Date(entrada.fechaHora))/60000);
          totalMinutos += mins;
        }
        detalle.push({
          fecha: fechaStr, estatus,
          horaEntrada: new Date(entrada.fechaHora).toLocaleTimeString('es-MX',{hour:'2-digit',minute:'2-digit',hour12:true}),
          horaSalida:  salida ? new Date(salida.fechaHora).toLocaleTimeString('es-MX',{hour:'2-digit',minute:'2-digit',hour12:true}) : null,
          minutosT: mins,
        });
      }
      const totalDias = aTiempo + retardos + faltas;
      reporte.push({
        empleadoId: h.empleadoId, nombre:`${h.nombre} ${h.apellido}`.trim(),
        sucursal: h.sucursal, aTiempo, retardos, faltas, diasLibres, diasFestivos,
        totalDias, puntualidad: totalDias>0 ? Math.round((aTiempo/totalDias)*100) : 100,
        horasTotales: totalMinutos>0 ? `${Math.floor(totalMinutos/60)}h ${totalMinutos%60}m` : '0h',
        minutosTotales: totalMinutos,
        detalle,
      });
    }
    reporte.sort((a,b)=>b.faltas-a.faltas||b.retardos-a.retardos);
    const MESES_ES=['Enero','Febrero','Marzo','Abril','Mayo','Junio','Julio','Agosto','Septiembre','Octubre','Noviembre','Diciembre'];
    res.json({ ok:true, data:reporte, mes:m+1, anio:y, mesNombre:MESES_ES[m], festivosDelMes:Object.values(mapaFestivos).map(f=>f.nombre) });
  } catch(e) {
    console.error('[REPORTE]', e);
    res.status(500).json({ error: e.message });
  }
});

app.listen(PORT, () => {
  console.log(`\n🚀 Servidor v5 corriendo en puerto ${PORT}`);
  console.log(`📅 Festivos MX: GET/PUT /api/festivos`);
  console.log(`📊 Resumen con festivos: GET /api/resumen\n`);
});
