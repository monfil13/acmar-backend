const express = require('express');
const router = express.Router();
const PDFDocument = require('pdfkit');
const authenticateToken = require('../middlewares/authMiddleware');
const pool = require('../config/database');
const path = require('path');
const fs = require('fs');
const multer = require('multer');
const xlsx = require('xlsx');

/** =========================
 * Config
 * ========================= */
const ROLES_ADMIN = ['super_admin', 'admin', 'control'];

const upload = multer({
  dest: path.join(__dirname, '../uploads'),
  limits: { fileSize: 10 * 1024 * 1024 },
});

/** =========================
 * Helpers
 * ========================= */
const isAdmin = (rol) => ROLES_ADMIN.includes(rol);
const normalize = (v) => String(v || '').trim();
const lower = (v) => normalize(v).toLowerCase();

/** =========================
 * 🔥 UBICACIONES (PÚBLICO)
 * ========================= */
router.get('/ubicaciones', async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT DISTINCT ubicacion_actual
      FROM inventario_v2
      WHERE ubicacion_actual IS NOT NULL
      ORDER BY ubicacion_actual
    `);

    res.json(result.rows.map(r => r.ubicacion_actual));
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: 'Error obteniendo ubicaciones' });
  }
});

/** =========================
 * GET INVENTARIO (SIN PAGINACIÓN)
 * ========================= */
router.get('/', authenticateToken, async (req, res) => {
  try {
    const { estatus, q, ubicacion } = req.query;
    const esAdmin = isAdmin(req.user.rol);

    const where = [];
    const values = [];

    // 🔒 Restricción por rol
    if (!esAdmin) {
      where.push(`ubicacion_actual = $${values.length + 1}`);
      values.push(req.user.ubicacion);
    } else if (ubicacion) {
      where.push(`ubicacion_actual = $${values.length + 1}`);
      values.push(ubicacion);
    }

    if (estatus) {
      where.push(`LOWER(estatus) = $${values.length + 1}`);
      values.push(lower(estatus));
    }

    if (q) {
      where.push(`(
        material ILIKE $${values.length + 1}
        OR descripcion ILIKE $${values.length + 1}
        OR iccid ILIKE $${values.length + 1}
        OR numero ILIKE $${values.length + 1}
      )`);
      values.push(`%${q}%`);
    }

    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';

    const result = await pool.query(
      `
      SELECT *
      FROM inventario_v2
      ${whereSql}
      ORDER BY created_at DESC
      `,
      values
    );

    res.json({
      inventario: result.rows,
      count: result.rows.length,
    });

  } catch (error) {
    console.error(error);
    res.status(500).json({ message: 'Error al obtener inventario' });
  }
});

/** =========================
 * GET PDF
 * ========================= */
router.get('/pdf', authenticateToken, async (req, res) => {
  try {
    const result = await pool.query(`SELECT * FROM inventario_v2 ORDER BY created_at DESC`);

    const doc = new PDFDocument({ margin: 20, size: 'A4', layout: 'landscape' });

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', 'attachment; filename=inventario.pdf');

    doc.pipe(res);

    doc.fontSize(18).text('Inventario ACCELMAR', { align: 'center' });
    doc.moveDown();

    result.rows.forEach((item) => {
      doc.fontSize(10).text(
        `${item.material} | ${item.descripcion} | ${item.estatus} | ${item.ubicacion_actual}`
      );
    });

    doc.end();

  } catch (error) {
    res.status(500).json({ message: 'Error PDF' });
  }
});

/** =========================
 * POST EXCEL
 * ========================= */
router.post('/excel', authenticateToken, upload.single('file'), async (req, res) => {
  try {
    if (!isAdmin(req.user.rol)) {
      return res.status(403).json({ message: 'Sin permisos' });
    }

    const workbook = xlsx.readFile(req.file.path);
    const sheet = workbook.Sheets[workbook.SheetNames[0]];
    const data = xlsx.utils.sheet_to_json(sheet);

    for (const row of data) {
      await pool.query(
        `
        INSERT INTO inventario_v2
        (material, descripcion, color, cantidad, precio_mayoreo, precio_publico, iccid, numero, estatus, ubicacion_actual)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
        `,
        [
          row.material,
          row.descripcion,
          row.color,
          row.cantidad,
          row.precio_mayoreo,
          row.precio_publico,
          row.iccid,
          row.numero,
          lower(row.estatus),
          row.ubicacion_actual,
        ]
      );
    }

    fs.unlinkSync(req.file.path);

    res.json({ message: 'Excel cargado correctamente' });

  } catch (error) {
    console.error(error);
    res.status(500).json({ message: 'Error al subir Excel' });
  }
});

/** =========================
 * GET POR MATERIAL (AL FINAL)
 * ========================= */
router.get('/:material', authenticateToken, async (req, res) => {
  try {
    const material = req.params.material;

    const result = await pool.query(
      `SELECT * FROM inventario_v2 WHERE material = $1`,
      [material]
    );

    if (!result.rows.length) {
      return res.status(404).json({ message: 'No encontrado' });
    }

    res.json(result.rows[0]);

  } catch (error) {
    res.status(500).json({ message: 'Error al obtener material' });
  }
});

/** =========================
 * PATCH
 * ========================= */
router.patch('/:material', authenticateToken, async (req, res) => {
  try {
    const material = req.params.material;
    const { estatus, ubicacion_actual } = req.body;

    const result = await pool.query(
      `
      UPDATE inventario_v2
      SET estatus = $1,
          ubicacion_actual = COALESCE($2, ubicacion_actual)
      WHERE material = $3
      RETURNING *
      `,
      [lower(estatus), ubicacion_actual, material]
    );

    res.json(result.rows[0]);

  } catch (error) {
    res.status(500).json({ message: 'Error al actualizar' });
  }
});

module.exports = router;