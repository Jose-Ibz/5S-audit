// ============================================================
// 5S AUDIT PRO — Google Apps Script Backend
// Náutica Viamar
// ============================================================
// INSTRUCCIONES DE INSTALACIÓN:
// 1. Abre script.google.com → Nuevo proyecto
// 2. Pega todo este código
// 3. Cambia SHEET_ID por el ID de tu Google Sheet
// 4. Guarda y despliega: Implementar → Nueva implementación
//    · Tipo: Aplicación web
//    · Ejecutar como: Yo
//    · Quién tiene acceso: Cualquier persona
// 5. Copia la URL del despliegue y pégala en el HTML
// ============================================================

// ── CONFIGURACIÓN ──────────────────────────────────────────
const SHEET_ID   = 'PON_AQUI_EL_ID_DE_TU_GOOGLE_SHEET'; // ← CAMBIA ESTO
const SECRET_KEY = 'NauticaViamar5S_2025_SecretKey';      // ← Clave interna (no la cambies salvo que quieras)
const TOKEN_TTL  = 8 * 60 * 60 * 1000;                    // Sesión: 8 horas en ms

// ── NOMBRES DE HOJAS ────────────────────────────────────────
const SH = {
  USERS:        'usuarios',
  AUDITS:       'auditorias',
  ESTADOS:      'estados',
  SEGUIMIENTOS: 'seguimientos',
  CONFIG:       'config',
  TOKENS:       'tokens'
};

// ============================================================
// PUNTO DE ENTRADA HTTP
// ============================================================
function doPost(e) {
  try {
    const body   = JSON.parse(e.postData.contents);
    const action = body.action;
    const token  = body.token || null;

    // Acciones públicas (sin autenticación)
    if (action === 'login')    return respond(handleLogin(body));
    if (action === 'ping')     return respond({ ok: true, msg: 'Servidor activo' });

    // Acciones de admin sin token (primer uso)
    if (action === 'setup')    return respond(handleSetup(body));

    // Todas las demás requieren token válido
    const user = verifyToken(token);
    if (!user) return respond({ ok: false, error: 'Sesión caducada. Inicia sesión de nuevo.' }, 401);

    switch (action) {
      // ── USUARIOS ──
      case 'getUsers':       return respond(getUsers(user));
      case 'createUser':     return respond(createUser(body, user));
      case 'updateUser':     return respond(updateUser(body, user));
      case 'deleteUser':     return respond(deleteUser(body, user));
      case 'changePassword': return respond(changePassword(body, user));
      case 'logout':         return respond(handleLogout(token));

      // ── DATOS ──
      case 'load':           return respond(loadAll(user));
      case 'saveAudit':      return respond(saveAudit(body, user));
      case 'deleteAudit':    return respond(deleteAudit(body, user));
      case 'saveEstado':     return respond(saveEstado(body, user));
      case 'saveSeguimiento':return respond(saveSeguimiento(body, user));
      case 'saveConfig':     return respond(saveConfig(body, user));
      case 'backup':         return respond(handleBackup(user));

      default: return respond({ ok: false, error: 'Acción desconocida: ' + action }, 400);
    }
  } catch (err) {
    return respond({ ok: false, error: 'Error del servidor: ' + err.message }, 500);
  }
}

function doGet(e) {
  return respond({ ok: true, msg: '5S Audit Pro API v1.0 — Náutica Viamar' });
}

// ============================================================
// SETUP INICIAL (solo si no hay usuarios)
// ============================================================
function handleSetup(body) {
  initSheets();
  const sh = getSheet(SH.USERS);
  if (sh.getLastRow() > 1) {
    return { ok: false, error: 'El sistema ya está configurado. Usa login.' };
  }
  if (!body.username || !body.password) {
    return { ok: false, error: 'Proporciona usuario y contraseña para el admin.' };
  }
  const hash = hashPassword(body.password);
  sh.appendRow([
    body.username.toLowerCase().trim(),
    hash,
    'admin',
    body.nombre || body.username,
    new Date().toISOString(),
    'activo'
  ]);
  return { ok: true, msg: 'Admin creado correctamente. Ya puedes iniciar sesión.' };
}

// ============================================================
// AUTENTICACIÓN
// ============================================================
function handleLogin(body) {
  if (!body.username || !body.password) {
    return { ok: false, error: 'Usuario y contraseña requeridos.' };
  }
  const sh   = getSheet(SH.USERS);
  const data = sh.getDataRange().getValues();
  const hash = hashPassword(body.password);

  for (let i = 1; i < data.length; i++) {
    const [uname, uhash, rol, nombre, , estado] = data[i];
    if (uname === body.username.toLowerCase().trim()) {
      if (estado !== 'activo')  return { ok: false, error: 'Usuario desactivado. Contacta al administrador.' };
      if (uhash !== hash)       return { ok: false, error: 'Contraseña incorrecta.' };

      // Generar token
      const token   = Utilities.getUuid();
      const expires = new Date(Date.now() + TOKEN_TTL).toISOString();
      const tsh     = getSheet(SH.TOKENS);
      tsh.appendRow([token, uname, rol, expires]);

      return { ok: true, token, user: { username: uname, nombre: nombre || uname, rol } };
    }
  }
  return { ok: false, error: 'Usuario no encontrado.' };
}

function handleLogout(token) {
  const tsh  = getSheet(SH.TOKENS);
  const data = tsh.getDataRange().getValues();
  for (let i = 1; i < data.length; i++) {
    if (data[i][0] === token) {
      tsh.deleteRow(i + 1);
      return { ok: true };
    }
  }
  return { ok: true }; // Ya no existe, igual cerramos
}

function verifyToken(token) {
  if (!token) return null;
  const tsh  = getSheet(SH.TOKENS);
  const data = tsh.getDataRange().getValues();
  const now  = Date.now();
  for (let i = 1; i < data.length; i++) {
    const [tok, uname, rol, expires] = data[i];
    if (tok === token) {
      if (new Date(expires).getTime() < now) {
        tsh.deleteRow(i + 1); // Expirado, eliminar
        return null;
      }
      return { username: uname, rol };
    }
  }
  return null;
}

// Limpia tokens expirados (llamar periódicamente o en login)
function cleanExpiredTokens() {
  const tsh  = getSheet(SH.TOKENS);
  const data = tsh.getDataRange().getValues();
  const now  = Date.now();
  for (let i = data.length - 1; i >= 1; i--) {
    if (new Date(data[i][3]).getTime() < now) tsh.deleteRow(i + 1);
  }
}

// ============================================================
// GESTIÓN DE USUARIOS
// ============================================================
function getUsers(caller) {
  requireAdmin(caller);
  const sh   = getSheet(SH.USERS);
  const data = sh.getDataRange().getValues();
  const users = [];
  for (let i = 1; i < data.length; i++) {
    const [username, , rol, nombre, creado, estado] = data[i];
    users.push({ username, rol, nombre, creado, estado });
  }
  return { ok: true, users };
}

function createUser(body, caller) {
  requireAdmin(caller);
  const { username, password, nombre, rol } = body;
  if (!username || !password) return { ok: false, error: 'Faltan datos.' };

  const sh   = getSheet(SH.USERS);
  const data = sh.getDataRange().getValues();
  for (let i = 1; i < data.length; i++) {
    if (data[i][0] === username.toLowerCase().trim()) {
      return { ok: false, error: 'El usuario ya existe.' };
    }
  }
  sh.appendRow([
    username.toLowerCase().trim(),
    hashPassword(password),
    rol || 'auditor',
    nombre || username,
    new Date().toISOString(),
    'activo'
  ]);
  return { ok: true, msg: 'Usuario creado correctamente.' };
}

function updateUser(body, caller) {
  requireAdmin(caller);
  const sh   = getSheet(SH.USERS);
  const data = sh.getDataRange().getValues();
  for (let i = 1; i < data.length; i++) {
    if (data[i][0] === body.username) {
      if (body.nombre) sh.getRange(i + 1, 4).setValue(body.nombre);
      if (body.rol)    sh.getRange(i + 1, 3).setValue(body.rol);
      if (body.estado) sh.getRange(i + 1, 6).setValue(body.estado);
      return { ok: true, msg: 'Usuario actualizado.' };
    }
  }
  return { ok: false, error: 'Usuario no encontrado.' };
}

function deleteUser(body, caller) {
  requireAdmin(caller);
  if (body.username === caller.username) {
    return { ok: false, error: 'No puedes eliminarte a ti mismo.' };
  }
  const sh   = getSheet(SH.USERS);
  const data = sh.getDataRange().getValues();
  for (let i = 1; i < data.length; i++) {
    if (data[i][0] === body.username) {
      sh.deleteRow(i + 1);
      return { ok: true, msg: 'Usuario eliminado.' };
    }
  }
  return { ok: false, error: 'Usuario no encontrado.' };
}

function changePassword(body, caller) {
  // Admin puede cambiar cualquiera, usuario solo la suya
  if (caller.rol !== 'admin' && body.username !== caller.username) {
    return { ok: false, error: 'Sin permisos.' };
  }
  if (!body.newPassword || body.newPassword.length < 6) {
    return { ok: false, error: 'La contraseña debe tener al menos 6 caracteres.' };
  }
  const sh   = getSheet(SH.USERS);
  const data = sh.getDataRange().getValues();
  for (let i = 1; i < data.length; i++) {
    if (data[i][0] === body.username) {
      sh.getRange(i + 1, 2).setValue(hashPassword(body.newPassword));
      return { ok: true, msg: 'Contraseña actualizada.' };
    }
  }
  return { ok: false, error: 'Usuario no encontrado.' };
}

// ============================================================
// DATOS — CARGA COMPLETA
// ============================================================
function loadAll(user) {
  const audits       = loadAudits();
  const estados      = loadEstados();
  const seguimientos = loadSeguimientos();
  const config       = loadConfig2();
  return { ok: true, audits, estados, seguimientos, config };
}

// ── AUDITORÍAS ──────────────────────────────────────────────
function loadAudits() {
  const sh   = getSheet(SH.AUDITS);
  const data = sh.getDataRange().getValues();
  const audits = [];
  for (let i = 1; i < data.length; i++) {
    if (!data[i][0]) continue;
    try { audits.push(JSON.parse(data[i][1])); } catch(e) {}
  }
  // Más reciente primero
  audits.sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));
  return audits;
}

function saveAudit(body, user) {
  if (!body.audit) return { ok: false, error: 'Sin datos de auditoría.' };
  const audit = body.audit;
  audit.savedBy = user.username;
  audit.savedAt = new Date().toISOString();

  const sh   = getSheet(SH.AUDITS);
  const data = sh.getDataRange().getValues();

  // Buscar si existe (actualizar)
  for (let i = 1; i < data.length; i++) {
    if (data[i][0] === audit.codigo) {
      sh.getRange(i + 1, 2).setValue(JSON.stringify(audit));
      sh.getRange(i + 1, 3).setValue(new Date().toISOString());
      return { ok: true, msg: 'Auditoría actualizada.' };
    }
  }
  // Nueva
  sh.appendRow([audit.codigo, JSON.stringify(audit), new Date().toISOString()]);
  return { ok: true, msg: 'Auditoría guardada.' };
}

function deleteAudit(body, user) {
  requireAdmin(user);
  const sh   = getSheet(SH.AUDITS);
  const data = sh.getDataRange().getValues();
  for (let i = 1; i < data.length; i++) {
    if (data[i][0] === body.codigo) {
      sh.deleteRow(i + 1);
      return { ok: true };
    }
  }
  return { ok: false, error: 'Auditoría no encontrada.' };
}

// ── ESTADOS TARJETAS ROJAS ───────────────────────────────────
function loadEstados() {
  const sh   = getSheet(SH.ESTADOS);
  const data = sh.getDataRange().getValues();
  const estados = {};
  for (let i = 1; i < data.length; i++) {
    if (!data[i][0]) continue;
    estados[data[i][0]] = { estado: data[i][1], updatedAt: data[i][2] };
  }
  return estados;
}

function saveEstado(body, user) {
  if (!body.rcId || !body.estado) return { ok: false, error: 'Sin datos.' };
  const sh   = getSheet(SH.ESTADOS);
  const data = sh.getDataRange().getValues();
  const now  = new Date().toISOString();

  for (let i = 1; i < data.length; i++) {
    if (data[i][0] === body.rcId) {
      sh.getRange(i + 1, 2).setValue(body.estado);
      sh.getRange(i + 1, 3).setValue(now);
      sh.getRange(i + 1, 4).setValue(user.username);
      return { ok: true };
    }
  }
  sh.appendRow([body.rcId, body.estado, now, user.username]);
  return { ok: true };
}

// ── SEGUIMIENTOS ─────────────────────────────────────────────
function loadSeguimientos() {
  const sh   = getSheet(SH.SEGUIMIENTOS);
  const data = sh.getDataRange().getValues();
  const segs = {};
  for (let i = 1; i < data.length; i++) {
    if (!data[i][0]) continue;
    const rcId = data[i][0];
    if (!segs[rcId]) segs[rcId] = [];
    try { segs[rcId].push(JSON.parse(data[i][1])); } catch(e) {}
  }
  return segs;
}

function saveSeguimiento(body, user) {
  if (!body.rcId || !body.seg) return { ok: false, error: 'Sin datos.' };
  const seg = body.seg;
  seg.savedBy = user.username;
  const sh = getSheet(SH.SEGUIMIENTOS);
  sh.appendRow([body.rcId, JSON.stringify(seg), new Date().toISOString()]);
  return { ok: true };
}

// ── CONFIG ───────────────────────────────────────────────────
function loadConfig2() {
  const sh   = getSheet(SH.CONFIG);
  const data = sh.getDataRange().getValues();
  const cfg  = {};
  for (let i = 1; i < data.length; i++) {
    if (data[i][0]) cfg[data[i][0]] = data[i][1];
  }
  return cfg;
}

function saveConfig(body, user) {
  requireAdmin(user);
  if (!body.config) return { ok: false, error: 'Sin datos.' };
  const sh   = getSheet(SH.CONFIG);
  const data = sh.getDataRange().getValues();
  const cfg  = body.config;

  Object.entries(cfg).forEach(([key, val]) => {
    let found = false;
    for (let i = 1; i < data.length; i++) {
      if (data[i][0] === key) {
        sh.getRange(i + 1, 2).setValue(val);
        data[i][1] = val;
        found = true;
        break;
      }
    }
    if (!found) sh.appendRow([key, val]);
  });
  return { ok: true };
}

// ============================================================
// UTILIDADES
// ============================================================
function hashPassword(password) {
  const raw = SECRET_KEY + password;
  return Utilities.base64Encode(Utilities.computeDigest(
    Utilities.DigestAlgorithm.SHA_256,
    raw,
    Utilities.Charset.UTF_8
  ));
}

function requireAdmin(user) {
  if (!user || user.rol !== 'admin') {
    throw new Error('Se requieren permisos de administrador.');
  }
}

function getSheet(name) {
  const ss = SpreadsheetApp.openById(SHEET_ID);
  let sh   = ss.getSheetByName(name);
  if (!sh) sh = ss.insertSheet(name);
  return sh;
}

function initSheets() {
  const headers = {
    [SH.USERS]:        ['username', 'password_hash', 'rol', 'nombre', 'creado', 'estado'],
    [SH.AUDITS]:       ['codigo', 'data_json', 'updated_at'],
    [SH.ESTADOS]:      ['rc_id', 'estado', 'updated_at', 'updated_by'],
    [SH.SEGUIMIENTOS]: ['rc_id', 'seg_json', 'created_at'],
    [SH.CONFIG]:       ['key', 'value'],
    [SH.TOKENS]:       ['token', 'username', 'rol', 'expires']
  };

  Object.entries(headers).forEach(([name, cols]) => {
    const sh = getSheet(name);
    if (sh.getLastRow() === 0) {
      sh.appendRow(cols);
      sh.getRange(1, 1, 1, cols.length)
        .setFontWeight('bold')
        .setBackground('#c89c20')
        .setFontColor('#000000');
    }
  });
}

// ============================================================
// BACKUP MANUAL DESDE LA APP
// ============================================================
function handleBackup(user) {
  requireAdmin(user);
  const ss     = SpreadsheetApp.openById(SHEET_ID);
  const fecha  = Utilities.formatDate(new Date(), 'Europe/Madrid', 'yyyy-MM-dd_HH-mm');
  const nombre = '5S-Audit-Backup-' + fecha;

  const iterCarpeta = DriveApp.getFoldersByName('5S Audit — Backups');
  const carpeta = iterCarpeta.hasNext() ? iterCarpeta.next() : DriveApp.createFolder('5S Audit — Backups');

  const copia = ss.copy(nombre);
  DriveApp.getFileById(copia.getId()).moveTo(carpeta);

  return { ok: true, nombre: nombre };
}

function respond(data, code) {
  const output = ContentService.createTextOutput(JSON.stringify(data))
    .setMimeType(ContentService.MimeType.JSON);
  return output;
}

// ============================================================
// TRIGGER: Limpiar tokens expirados diariamente
// Ejecutar manualmente 1 vez para crear el trigger:
// function crearTriggerLimpieza() {
//   ScriptApp.newTrigger('cleanExpiredTokens')
//     .timeBased().everyDays(1).create();
// }
// ============================================================
