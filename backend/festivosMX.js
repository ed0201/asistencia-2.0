/**
 * Días Festivos Mexicanos
 * Fuente: Ley Federal del Trabajo (Art. 74)
 * Tipos: 'obligatorio' | 'opcional' | 'personalizado'
 */

function lunesN(anio, mes, n) {
  const d = new Date(anio, mes - 1, 1);
  const diasHastaLunes = (8 - d.getDay()) % 7 || 7;
  const primerLunes = 1 + (diasHastaLunes === 7 ? 0 : diasHastaLunes);
  const resultado = primerLunes + (n - 1) * 7;
  return `${anio}-${String(mes).padStart(2,'0')}-${String(resultado).padStart(2,'0')}`;
}

function festivosLFT(anio) {
  return [
    { fecha:`${anio}-01-01`, nombre:'Año Nuevo',                    tipo:'obligatorio', movible:false },
    { fecha:lunesN(anio,2,1), nombre:'Constitución Mexicana',       tipo:'obligatorio', movible:true,  descripcion:'5 de febrero (primer lunes de febrero)' },
    { fecha:lunesN(anio,3,3), nombre:'Natalicio de Benito Juárez',  tipo:'obligatorio', movible:true,  descripcion:'21 de marzo (tercer lunes de marzo)' },
    { fecha:`${anio}-05-01`, nombre:'Día del Trabajo',              tipo:'obligatorio', movible:false },
    { fecha:`${anio}-09-16`, nombre:'Independencia de México',      tipo:'obligatorio', movible:false },
    { fecha:lunesN(anio,11,3), nombre:'Revolución Mexicana',        tipo:'obligatorio', movible:true,  descripcion:'20 de noviembre (tercer lunes de noviembre)' },
    { fecha:`${anio}-12-25`, nombre:'Navidad',                      tipo:'obligatorio', movible:false },
    { fecha:`${anio}-02-14`, nombre:'Día de San Valentín',          tipo:'opcional',    movible:false },
    { fecha:`${anio}-04-30`, nombre:'Día del Niño',                 tipo:'opcional',    movible:false },
    { fecha:`${anio}-05-10`, nombre:'Día de las Madres',            tipo:'opcional',    movible:false },
    { fecha:`${anio}-11-01`, nombre:'Día de Todos los Santos',      tipo:'opcional',    movible:false },
    { fecha:`${anio}-11-02`, nombre:'Día de Muertos',               tipo:'opcional',    movible:false },
    { fecha:`${anio}-12-12`, nombre:'Virgen de Guadalupe',          tipo:'opcional',    movible:false },
    { fecha:`${anio}-12-24`, nombre:'Nochebuena',                   tipo:'opcional',    movible:false },
    { fecha:`${anio}-12-31`, nombre:'Fin de Año',                   tipo:'opcional',    movible:false },
  ];
}

function esFestivo(fechaStr, festivosActivos) {
  return festivosActivos.find(f => f.fecha === fechaStr) || null;
}

module.exports = { festivosLFT, esFestivo, lunesN };
