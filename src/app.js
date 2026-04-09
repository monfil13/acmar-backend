const express = require('express');
const cors = require('cors');
const pool = require('./config/database');

const authRoutes = require('./routes/authRoutes');
const inventarioRoutes = require('./routes/inventarioRoutes');
const movimientosRoutes = require('./routes/movimientosRoutes');
const notasRoutes = require('./routes/notasRoutes');
const reportesRoutes = require('./routes/reportesRoutes');
const dashboardRoutes = require('./routes/dashboardRoutes');

const app = express();

/** =========================
 * Config
 * ========================= */
const FRONTEND_ORIGIN = process.env.FRONTEND_ORIGIN || 'http://localhost:5173';

/** =========================
 * Middlewares globales
 * ========================= */
app.use(
  cors({
    origin: FRONTEND_ORIGIN,
    credentials: true,
    methods: ['GET', 'POST', 'PATCH', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization'],
  })
);

// Preflight (NO usar '*' porque truena con path-to-regexp en tu setup)
app.options(/.*/, cors());

app.use(express.json({ limit: '2mb' }));

/** =========================
 * Conexión a PostgreSQL
 * ========================= */
pool
  .connect()
  .then((client) => {
    client.release();
    console.log('✅ Conectado a PostgreSQL');
  })
  .catch((err) => {
    console.error('❌ Error de conexión a la BD:', err.message);
  });

/** =========================
 * Healthcheck
 * ========================= */
app.get('/', (req, res) => {
  res.json({ message: 'API ACCELMAR funcionando 🚀', status: 'ok' });
});

app.get('/health', async (req, res) => {
  try {
    await pool.query('SELECT 1');
    res.json({ status: 'ok', db: 'ok' });
  } catch (err) {
    res.status(500).json({ status: 'error', db: 'down', error: err.message });
  }
});

/** =========================
 * Rutas principales
 * ========================= */
app.use('/auth', authRoutes);
app.use('/inventario', inventarioRoutes);
app.use('/movimientos', movimientosRoutes);
app.use('/notas', notasRoutes);
app.use('/reportes', reportesRoutes);
app.use('/dashboard', dashboardRoutes);

/** =========================
 * 404 - Ruta no encontrada
 * ========================= */
app.use((req, res) => {
  res.status(404).json({
    message: 'Ruta no encontrada',
    path: req.originalUrl,
  });
});

/** =========================
 * Manejo global de errores
 * ========================= */
app.use((err, req, res, next) => {
  console.error('❌ Error no controlado:', err);
  res.status(err.status || 500).json({
    message: err.message || 'Error interno del servidor',
  });
});

module.exports = app;