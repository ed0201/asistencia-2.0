const express    = require('express');
const mongoose   = require('mongoose');
const bodyParser = require('body-parser');
const cors       = require('cors');
const bcrypt     = require('bcryptjs');
const jwt        = require('jsonwebtoken');
const path       = require('path');

const app  = express();
const PORT = process.env.PORT || 8000;
const JWT_SECRET = process.env.JWT_SECRET || 'cambia_esto_en_produccion_123';

// ─── Middleware ───────────────────────────────────────────────────────────────
app.use(cors());
app.use(bodyParser.text({ type: '*/*' }));
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));

// ─── MongoDB ──────────────────────────────────────────────────────────────────
mongoose.connect(process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017/asistencia_pwa')
  .then(() => console.log('✅ MongoDB conectado'))
  .catch(err => console.error('❌ MongoDB error:', err));

// ─── Modelos ──────────────────────────────────────────────────────────────────
const RegistroSchema = new mongoose.Schema({
  empleadoId:    { type: String, required: true, index: true },
  fechaHora:     { type: Date,   required: true, index: true },
  sucursal:      { type: String, required: true, enum: ['Ameca', 'Tepetlixpa', 'Desconocida'] },
  tipoEvento:    { type: String, default: 'Entrada', enum: ['Entrada', 'Salida', 'Desconocido'] },
  tipoRegistro:  { type: String, default: 'Asistencia', enum: ['Asistencia', 'Enfermedad', 'Vacaciones', 'Comisión'] },
  fuente:        { type: String, default: 'agente', enum: ['agente', 'adms', 'manual'] },
  numeroSerie:   { type: String, default: '' },
  fechaRegistro: { type: Date,   default: Date.now },
}, { timestamps: true });

// Evitar duplicados: mismo empleado, misma fechaHora, misma sucursal
RegistroSchema.index({ empleadoId: 1, fechaHora: 1, sucursal: 1 }, { unique: true });

const Registro = mongoose.model('Registro', RegistroSchema);

const SyncLogSchema = new mongoose.Schema({
  sucursal:    String,
  totalLeidos: Number,
  guardados:   Number,
  duplicados:  Number,
  errores:     Number,
  fechaSync:   { type: Date, default: Date.now },
  agentVersion: String,
});
const SyncLog = mongoose.model('SyncLog', SyncLogSchema);

// ─── Auth Middleware ──────────────────────────────────────────────────────────
const AUTH_USER = process.env.AUTH_USER || 'admin';
const AUTH_PASS = process.env.AUTH_PASS || 'asistencia2024';
const AGENT_KEY = process.env.AGENT_KEY || 'clave_agente_secreta_456';

function requireAuth(req, res, next) {
  const token = req.headers.authorization?.replace('Bearer ', '');
  if (!token) return res.status(401).json({ error: 'Token requerido' });
  try {
    req.user = jwt.verify(token, JWT_SECRET);
    next();
  } catch {
    res.status(401).json({ error: 'Token inválido o expirado' });
  }
}

function requireAgentKey(req, res, next) {
  const key = req.headers['x-agent-key'];
  if (key !== AGENT_KEY) return res.status(401).json({ error: 'Clave de agente inválida' });
  next();
}

// ─── Mapeo de Números de Serie ────────────────────────────────────────────────
const mapaSeriesSucursal = {
  [process.env.SN_AMECA      || 'XXXX123A']: 'Ameca',
  [process.env.SN_TEPETLIXPA || 'YYYY456T']: 'Tepetlixpa',
};
const IDS_ADMIN = (process.env.IDS_ADMIN || '1,2').split(',').map(s => s.trim());

// ─── Rutas Públicas ───────────────────────────────────────────────────────────

// Health check
app.get('/', (req, res) => res.json({ ok: true, sistema: 'Asistencia PWA v2', ts: new Date() }));
app.get('/debug', (req, res) => res.json({ user: process.env.AUTH_USER, pass: process.env.AUTH_PASS }));
// Login
app.post('/api/auth/login', (req, res) => {
  const { usuario, password } = req.body;
  console.log('LOGIN INTENTO:', usuario, password);
  console.log('ENV USER:', process.env.AUTH_USER);
  console.log('ENV PASS:', process.env.AUTH_PASS);
  const validUser = process.env.AUTH_USER || 'admin';
  const validPass = process.env.AUTH_PASS || 'admin123';
  console.log('COMPARANDO:', usuario === validUser, password === validPass);
  if (usuario !== validUser || password !== validPass) {
    return res.status(401).json({ error: 'Credenciales incorrectas' });
  }
  const secret = process.env.JWT_SECRET || 'cambia_esto_en_produccion_123';
  const token = jwt.sign({ usuario, role: 'admin' }, secret, { expiresIn: '30d' });
  res.json({ token, usuario });
});

// ─── Rutas ADMS (fallback para checadores con ADMS habilitado) ────────────────
app.get('/iclock/cdata', (req, res) => res.status(200).send('OK'));

app.post('/iclock/cdata', async (req, res) => {
  const sn = req.query.SN || '';
  const sucursal = mapaSeriesSucursal[sn] || 'Desconocida';
  const contenido = typeof req.body === 'string' ? req.body : '';
  const lineas = contenido.split('\n').filter(l => l.trim());

  let guardados = 0;
  for (const linea of lineas) {
    const partes = linea.trim().split('\t');
    if (partes.length < 2) continue;
    const empleadoId = partes[0].trim();
    if (IDS_ADMIN.includes(empleadoId)) continue;
    const fechaHora = new Date(partes[1].trim().replace(' ', 'T'));
    if (isNaN(fechaHora)) continue;
    try {
      await Registro.create({ empleadoId, fechaHora, sucursal, fuente: 'adms', numeroSerie: sn });
      guardados++;
    } catch (e) {
      if (e.code !== 11000) console.error('[ADMS] Error:', e.message);
    }
  }
  console.log(`[ADMS] SN:${sn} → ${sucursal} | ${guardados} guardados`);
  res.status(200).send('OK');
});

// ─── Ruta de Sincronización del Agente ───────────────────────────────────────
// El agente local POST aquí con un lote de registros
app.post('/api/sync', requireAgentKey, async (req, res) => {
  const { registros, sucursal, agentVersion } = req.body;

  if (!Array.isArray(registros) || !sucursal) {
    return res.status(400).json({ error: 'Faltan campos: registros[], sucursal' });
  }

  let guardados = 0, duplicados = 0, errores = 0;

  for (const r of registros) {
    try {
      await Registro.create({
        empleadoId:   String(r.empleadoId),
        fechaHora:    new Date(r.fechaHora),
        sucursal,
        tipoEvento:   r.tipoEvento || 'Desconocido',
        tipoRegistro: 'Asistencia',
        fuente:       'agente',
        numeroSerie:  r.numeroSerie || '',
      });
      guardados++;
    } catch (e) {
      if (e.code === 11000) duplicados++;
      else { errores++; console.error('[SYNC] Error:', e.message); }
    }
  }

  await SyncLog.create({ sucursal, totalLeidos: registros.length, guardados, duplicados, errores, agentVersion });
  console.log(`[SYNC] ${sucursal}: ${guardados} nuevos, ${duplicados} duplicados, ${errores} errores`);
  res.json({ ok: true, guardados, duplicados, errores });
});

// ─── API Protegida (Frontend) ─────────────────────────────────────────────────

// Registros con filtros
app.get('/api/registros', requireAuth, async (req, res) => {
  try {
    const { sucursal, fecha, empleadoId, page = 1, limit = 200 } = req.query;
    const filter = {};
    if (sucursal && sucursal !== 'Todas') filter.sucursal = sucursal;
    if (empleadoId) filter.empleadoId = new RegExp(empleadoId, 'i');
    if (fecha) {
      const inicio = new Date(fecha + 'T00:00:00');
      const fin    = new Date(fecha + 'T23:59:59');
      filter.fechaHora = { $gte: inicio, $lte: fin };
    }
    const [data, total] = await Promise.all([
      Registro.find(filter).sort({ fechaHora: -1 }).skip((page - 1) * limit).limit(Number(limit)).lean(),
      Registro.countDocuments(filter),
    ]);
    res.json({ ok: true, data, total, page: Number(page) });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Estadísticas de resumen
app.get('/api/stats', requireAuth, async (req, res) => {
  try {
    const hoyInicio = new Date(); hoyInicio.setHours(0,0,0,0);
    const hoyFin    = new Date(); hoyFin.setHours(23,59,59,999);
    const [total, hoy, ameca, tepetlixpa, ultimoSync] = await Promise.all([
      Registro.countDocuments(),
      Registro.countDocuments({ fechaHora: { $gte: hoyInicio, $lte: hoyFin } }),
      Registro.countDocuments({ sucursal: 'Ameca' }),
      Registro.countDocuments({ sucursal: 'Tepetlixpa' }),
      SyncLog.findOne().sort({ fechaSync: -1 }).lean(),
    ]);
    res.json({ ok: true, total, hoy, ameca, tepetlixpa, ultimoSync });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Registro manual (incidencias)
app.post('/api/registros/manual', requireAuth, async (req, res) => {
  try {
    const { empleadoId, sucursal, tipoRegistro } = req.body;
    if (!empleadoId || !sucursal || !tipoRegistro) {
      return res.status(400).json({ error: 'Faltan campos requeridos' });
    }
    const r = await Registro.create({
      empleadoId: empleadoId.trim(),
      fechaHora: new Date(),
      sucursal,
      tipoRegistro,
      fuente: 'manual',
      numeroSerie: 'MANUAL',
    });
    res.status(201).json({ ok: true, data: r });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Historial de sincronizaciones
app.get('/api/sync/logs', requireAuth, async (req, res) => {
  const logs = await SyncLog.find().sort({ fechaSync: -1 }).limit(20).lean();
  res.json({ ok: true, data: logs });
});

// ─── Servidor ─────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`\n🚀 Servidor corriendo en puerto ${PORT}`);
  console.log(`📡 ADMS:  POST /iclock/cdata`);
  console.log(`🔄 Sync:  POST /api/sync  (clave agente requerida)`);
  console.log(`🖥️  API:   GET  /api/registros  (JWT requerido)\n`);
});
