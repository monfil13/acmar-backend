const express = require('express');
const router = express.Router();

const authenticateToken = require('../middlewares/authMiddleware');
const pool = require('../config/database');

/** =========================
 * Roles / Helpers
 * ========================= */
const ROLES_ADMIN = ['super_admin', 'admin', 'control'];

function isAdminControl(rol) {
  return ROLES_ADMIN.includes(rol);
}

function normalizeText(v) {
  return String(v || '').trim();
}

/** =========================
 * GET /dashboard
 * ========================= */
router.get('/', authenticateToken, async (req, res) => {
  try {
    const esAdmin = isAdminControl(req.user.rol);

    res.json({
      message: 'Módulo dashboard activo',
      scope: esAdmin ? 'all' : 'own_ubicacion',
      endpoints: [
        'GET /dashboard/resumen',
      ],
    });
  } catch (error) {
    console.error('❌ Error GET /dashboard:', error);
    res.status(500).json({
      message: 'Error en dashboard',
      error: error.message,
    });
  }
});

/** =========================
 * GET /dashboard/resumen
 *
 * Reglas:
 *  - admin/control: resumen global
 *  - PV: resumen solo de su ubicación
 * ========================= */
router.get('/resumen', authenticateToken, async (req, res) => {
  try {
    const esAdmin = isAdminControl(req.user.rol);
    const ubicacionUsuario = normalizeText(req.user.ubicacion);

    if (!esAdmin && !ubicacionUsuario) {
      return res.status(400).json({ message: 'Tu usuario no tiene ubicacion asignada' });
    }

    const hoy = new Date().toISOString().slice(0, 10);

    /** =========================
     * 1) Inventario general
     * ========================= */
    let inventarioWhere = '';
    let inventarioValues = [];

    if (!esAdmin) {
      inventarioWhere = `WHERE ubicacion_actual = $1`;
      inventarioValues = [ubicacionUsuario];
    }

    const inventarioResumenRes = await pool.query(
      `
      SELECT
        COUNT(*) AS inventario_total,
        COUNT(*) FILTER (WHERE LOWER(estatus) = 'disponible') AS inventario_disponible,
        COUNT(*) FILTER (WHERE LOWER(estatus) = 'vendido') AS inventario_vendido,
        COALESCE(SUM(COALESCE(precio_mayoreo,'0')::numeric), 0) AS valor_mayoreo_total,
        COALESCE(SUM(COALESCE(precio_publico,'0')::numeric), 0) AS valor_publico_total
      FROM inventario_v2
      ${inventarioWhere}
      `,
      inventarioValues
    );

    /** =========================
     * 2) Notas de hoy
     * ========================= */
    let notasWhere = `
    WHERE n.created_at >= $1
        AND n.created_at <= $2
    `;
    let notasValues = [`${hoy} 00:00:00`, `${hoy} 23:59:59`];

    if (!esAdmin) {
    notasWhere += ` AND (n.origen = $3 OR n.destino = $3 OR n.usuario_id = $4)`;
    notasValues.push(ubicacionUsuario, req.user.id);
    }

    const notasResumenRes = await pool.query(
    `
    SELECT
        COUNT(DISTINCT n.id) FILTER (WHERE LOWER(n.tipo) = 'venta') AS ventas_hoy,
        COUNT(DISTINCT n.id) FILTER (WHERE LOWER(n.tipo) = 'remision') AS remisiones_hoy,
        COUNT(ni.id) FILTER (WHERE LOWER(n.tipo) = 'venta') AS equipos_vendidos_hoy,
        COALESCE(SUM(CASE WHEN LOWER(n.tipo) = 'venta' THEN COALESCE(ni.precio_mayoreo,'0')::numeric ELSE 0 END), 0) AS total_mayoreo_hoy,
        COALESCE(SUM(CASE WHEN LOWER(n.tipo) = 'venta' THEN COALESCE(ni.precio_publico,'0')::numeric ELSE 0 END), 0) AS total_publico_hoy
    FROM notas n
    LEFT JOIN nota_items ni ON ni.nota_id = n.id
    ${notasWhere}
    `,
    notasValues
    );
    /** =========================
     * 3) Inventario por ubicación
     * ========================= */
    let ubicacionesQuery = `
      SELECT
        ubicacion_actual,
        COUNT(*) AS total_items,
        COUNT(*) FILTER (WHERE LOWER(estatus) = 'disponible') AS disponibles,
        COUNT(*) FILTER (WHERE LOWER(estatus) = 'vendido') AS vendidos
      FROM inventario_v2
    `;
    let ubicacionesValues = [];

    if (!esAdmin) {
      ubicacionesQuery += ` WHERE ubicacion_actual = $1`;
      ubicacionesValues.push(ubicacionUsuario);
    }

    ubicacionesQuery += `
      GROUP BY ubicacion_actual
      ORDER BY total_items DESC, ubicacion_actual ASC
    `;

    const porUbicacionRes = await pool.query(ubicacionesQuery, ubicacionesValues);

    /** =========================
     * 4) Ventas hoy por ubicación
     * ========================= */
    let ventasUbicacionQuery = `
      SELECT
        n.origen AS ubicacion,
        COUNT(DISTINCT n.id) AS total_notas,
        COUNT(ni.id) AS total_items,
        COALESCE(SUM(COALESCE(ni.precio_mayoreo,'0')::numeric), 0) AS total_mayoreo,
        COALESCE(SUM(COALESCE(ni.precio_publico,'0')::numeric), 0) AS total_publico
      FROM notas n
      LEFT JOIN nota_items ni ON ni.nota_id = n.id
      WHERE LOWER(n.tipo) = 'venta'
        AND n.created_at >= $1
        AND n.created_at <= $2
    `;
    let ventasUbicacionValues = [`${hoy} 00:00:00`, `${hoy} 23:59:59`];

    if (!esAdmin) {
      ventasUbicacionQuery += ` AND n.origen = $3`;
      ventasUbicacionValues.push(ubicacionUsuario);
    }

    ventasUbicacionQuery += `
      GROUP BY n.origen
      ORDER BY total_publico DESC, ubicacion ASC
    `;

    const ventasPorUbicacionRes = await pool.query(ventasUbicacionQuery, ventasUbicacionValues);

    const inv = inventarioResumenRes.rows[0];
    const notas = notasResumenRes.rows[0];

    res.json({
      message: 'Dashboard generado correctamente',
      fecha: hoy,
      scope: esAdmin ? 'all' : 'own_ubicacion',
      ubicacion: esAdmin ? null : ubicacionUsuario,
      resumen: {
        inventario_total: Number(inv.inventario_total || 0),
        inventario_disponible: Number(inv.inventario_disponible || 0),
        inventario_vendido: Number(inv.inventario_vendido || 0),
        valor_mayoreo_total: Number(inv.valor_mayoreo_total || 0),
        valor_publico_total: Number(inv.valor_publico_total || 0),

        ventas_hoy: Number(notas.ventas_hoy || 0),
        remisiones_hoy: Number(notas.remisiones_hoy || 0),
        equipos_vendidos_hoy: Number(notas.equipos_vendidos_hoy || 0),
        total_mayoreo_hoy: Number(notas.total_mayoreo_hoy || 0),
        total_publico_hoy: Number(notas.total_publico_hoy || 0),
      },
      por_ubicacion: porUbicacionRes.rows.map(r => ({
        ubicacion_actual: r.ubicacion_actual,
        total_items: Number(r.total_items || 0),
        disponibles: Number(r.disponibles || 0),
        vendidos: Number(r.vendidos || 0),
      })),
      ventas_hoy_por_ubicacion: ventasPorUbicacionRes.rows.map(r => ({
        ubicacion: r.ubicacion,
        total_notas: Number(r.total_notas || 0),
        total_items: Number(r.total_items || 0),
        total_mayoreo: Number(r.total_mayoreo || 0),
        total_publico: Number(r.total_publico || 0),
      })),
    });
  } catch (error) {
    console.error('❌ Error GET /dashboard/resumen:', error);
    res.status(500).json({
      message: 'Error al generar dashboard',
      error: error.message,
    });
  }
});

module.exports = router;