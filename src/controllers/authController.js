const pool = require('../config/database');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');

function requiredEnv(name) {
  if (!process.env[name]) throw new Error(`Falta variable de entorno: ${name}`);
  return process.env[name];
}

function normalizeEmail(email) {
  return String(email || '').trim().toLowerCase();
}

function safeUser(u) {
  return {
    id: u.id,
    email: u.email,
    rol: u.rol,
    ubicacion: u.ubicacion ?? null,
  };
}

exports.login = async (req, res) => {
  try {
    requiredEnv('JWT_SECRET');

    if (!req.body) {
      return res.status(400).json({ message: 'Body requerido (JSON)' });
    }

    const email = normalizeEmail(req.body.email);
    const password = String(req.body.password || '');

    if (!email || !password) {
      return res.status(400).json({ message: 'email y password son requeridos' });
    }

    // Buscar usuario
    const result = await pool.query(
      `SELECT id, email, password, rol, ubicacion
       FROM usuarios
       WHERE lower(email) = $1
       LIMIT 1`,
      [email]
    );

    if (result.rows.length === 0) {
      return res.status(401).json({ message: 'Credenciales inválidas' });
    }

    const user = result.rows[0];

    // Validar password (bcrypt)
    const ok = await bcrypt.compare(password, user.password);
    if (!ok) {
      return res.status(401).json({ message: 'Credenciales inválidas' });
    }

    const payload = {
      id: user.id,
      email: user.email,
      rol: user.rol,
      ubicacion: user.ubicacion ?? null,
    };

    const expiresIn = process.env.JWT_EXPIRES_IN || '2h';
    const token = jwt.sign(payload, process.env.JWT_SECRET, { expiresIn });

    return res.json({
      message: 'Login exitoso',
      token,
      usuario: safeUser(user),
      expiresIn,
    });
  } catch (error) {
    console.error('❌ Error login:', error);
    return res.status(500).json({ message: 'Error en el servidor', error: error.message });
  }
};