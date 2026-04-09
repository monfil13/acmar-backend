const express = require('express');
const router = express.Router();
const authenticateToken = require('../middlewares/authMiddleware');
const pool = require('../config/database');

// ==========================
// POST /movimientos
// Crea un movimiento y actualiza inventario_v2
// ==========================
router.post('/', authenticateToken, async (req, res) => {
  try {
    const { material, tipo, origen, destino, cliente, comentario } = req.body;

    // Validaciones básicas
    if (!material || !tipo || !origen || !destino) {
      return res.status(400).json({
        message: 'material, tipo, origen y destino son requeridos'
      });
    }

    const tipoNormalizado = String(tipo).trim().toLowerCase();
    const origenNorm = String(origen).trim();
    const destinoNorm = String(destino).trim();
    const clienteNorm = (cliente || '').trim();

    const tiposValidos = new Set(['remision', 'venta', 'traslado']);
    if (!tiposValidos.has(tipoNormalizado)) {
      return res.status(400).json({
        message: 'tipo inválido. Usa: remision | venta | traslado'
      });
    }

    // 1) Validar que el material exista
    const inv = await pool.query(
      'SELECT material, estatus, ubicacion_actual FROM inventario_v2 WHERE material = $1',
      [material]
    );
    if (inv.rows.length === 0) {
      return res.status(404).json({ message: 'Material no encontrado' });
    }

    // 2) Si ya está vendido, no permitir más movimientos
    if ((inv.rows[0].estatus || '').toLowerCase() === 'vendido') {
      return res.status(409).json({
        message: 'El material ya está vendido y no puede moverse'
      });
    }

    // 3) Evitar duplicados consecutivos (mismo tipo/origen/destino/cliente)
    const last = await pool.query(
      `SELECT tipo, origen, destino, COALESCE(cliente,'') AS cliente
       FROM movimientos
       WHERE material = $1
       ORDER BY created_at DESC
       LIMIT 1`,
      [material]
    );

    if (last.rows.length > 0) {
      const prev = last.rows[0];

      if (
        String(prev.tipo).toLowerCase() === tipoNormalizado &&
        String(prev.origen) === origenNorm &&
        String(prev.destino) === destinoNorm &&
        String(prev.cliente || '') === clienteNorm
      ) {
        return res.status(409).json({
          message: 'Movimiento duplicado detectado (ya estaba registrado)'
        });
      }
    }

    // 4) Insertar movimiento
    const mov = await pool.query(
      `INSERT INTO movimientos (material, tipo, origen, destino, cliente, usuario_id, comentario)
       VALUES ($1,$2,$3,$4,$5,$6,$7)
       RETURNING *`,
      [material, tipoNormalizado, origenNorm, destinoNorm, clienteNorm || null, req.user.id, comentario || null]
    );

    // 5) Actualizar inventario según tipo
    // - venta: estatus vendido + fecha_venta + ubicacion CLIENTE
    // - remision/traslado: solo cambia ubicación
    let updated;

    if (tipoNormalizado === 'venta') {
      const ubicCliente = clienteNorm ? `CLIENTE: ${clienteNorm}` : 'CLIENTE FINAL';

      updated = await pool.query(
        `UPDATE inventario_v2
         SET estatus = 'vendido',
             fecha_venta = now(),
             ubicacion_actual = $1
         WHERE material = $2
         RETURNING *`,
        [ubicCliente, material]
      );
    } else {
      updated = await pool.query(
        `UPDATE inventario_v2
         SET ubicacion_actual = $1
         WHERE material = $2
         RETURNING *`,
        [destinoNorm, material]
      );
    }

    // 6) Auditoría
    await pool.query(
      `INSERT INTO auditoria (usuario_id, material, accion, detalle)
       VALUES ($1,$2,$3,$4)`,
      [
        req.user.id,
        material,
        'movimiento',
        `${tipoNormalizado} | ${origenNorm} -> ${destinoNorm}${clienteNorm ? ` | cliente: ${clienteNorm}` : ''}`
      ]
    );

    return res.json({
      message: 'Movimiento registrado correctamente',
      movimiento: mov.rows[0],
      inventario: updated.rows[0]
    });
  } catch (error) {
    console.error('❌ Error POST /movimientos:', error);
    res.status(500).json({
      message: 'Error al registrar movimiento',
      error: error.message
    });
  }
});

// ==========================
// GET /movimientos/:material
// Historial de movimientos de un material
// ==========================
router.get('/:material', authenticateToken, async (req, res) => {
  try {
    const { material } = req.params;

    const r = await pool.query(
      `SELECT * FROM movimientos
       WHERE material = $1
       ORDER BY created_at DESC`,
      [material]
    );

    res.json({ material, movimientos: r.rows });
  } catch (error) {
    console.error('❌ Error GET /movimientos/:material:', error);
    res.status(500).json({
      message: 'Error al obtener movimientos',
      error: error.message
    });
  }
});

module.exports = router;