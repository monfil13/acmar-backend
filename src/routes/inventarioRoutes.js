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
 * Roles / Config
 * ========================= */
const ROLES_ADMIN = ['super_admin', 'admin', 'control'];

const upload = multer({
  dest: path.join(__dirname, '../uploads'),
  limits: { fileSize: 10 * 1024 * 1024 }, // 10MB
});

/** =========================
 * Helpers
 * ========================= */
function isAdminControl(rol) {
  return ROLES_ADMIN.includes(rol);
}

function normalizeText(v) {
  return String(v || '').trim();
}

function normalizeLower(v) {
  return String(v || '').trim().toLowerCase();
}

function fmtFechaES(date) {
  return new Date(date).toLocaleString('es-MX', {
    year: 'numeric',
    month: 'short',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function money(n) {
  const x = Number(n || 0);
  if (!Number.isFinite(x)) return '';
  return `$${x.toFixed(2)}`;
}

function canSeeItem(user, item) {
  if (isAdminControl(user.rol)) return true;
  return !!user.ubicacion && item.ubicacion_actual === user.ubicacion;
}

function safeDeleteFile(filePath) {
  if (!filePath) return;
  fs.unlink(filePath, (err) => {
    if (err) {
      console.warn('⚠️ No se pudo borrar archivo temporal:', filePath, err.message);
    }
  });
}

function buildInventarioBase(req) {
  const esAdmin = isAdminControl(req.user.rol);

  const estatus = normalizeLower(req.query.estatus);
  const q = normalizeText(req.query.q);
  const ubicacionQuery = normalizeText(req.query.ubicacion);

  const where = [];
  const values = [];

  if (!esAdmin) {
    if (!req.user.ubicacion) {
      return {
        error: { status: 400, message: 'Tu usuario no tiene ubicacion asignada' },
      };
    }
    where.push(`ubicacion_actual = $${values.length + 1}`);
    values.push(req.user.ubicacion);
  } else if (ubicacionQuery) {
    where.push(`ubicacion_actual = $${values.length + 1}`);
    values.push(ubicacionQuery);
  }

  if (estatus && ['disponible', 'vendido'].includes(estatus)) {
    where.push(`LOWER(estatus) = $${values.length + 1}`);
    values.push(estatus);
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

  return {
    esAdmin,
    whereSql,
    values,
  };
}

/** =========================
 * GET /inventario/pdf
 * ⚠️ Debe ir ANTES de /:material
 * ========================= */
router.get('/pdf', authenticateToken, async (req, res) => {
  try {
    const filters = buildInventarioBase(req);
    if (filters.error) {
      return res.status(filters.error.status).json({ message: filters.error.message });
    }

    const { esAdmin, whereSql, values } = filters;

    const result = await pool.query(
      `
      SELECT *
      FROM inventario_v2
      ${whereSql}
      ORDER BY created_at DESC
      `,
      values
    );

    const inventario = result.rows;

    const doc = new PDFDocument({ margin: 22, size: 'A4', layout: 'landscape' });

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', 'attachment; filename=inventario.pdf');
    doc.pipe(res);

    const pageWidth = doc.page.width;
    const pageHeight = doc.page.height;
    const left = doc.page.margins.left;
    const right = pageWidth - doc.page.margins.right;
    const usableWidth = pageWidth - (doc.page.margins.left + doc.page.margins.right);

    const logoPath = path.join(__dirname, '../assets/logo.png');
    const logoW = 120;

    const columns = [
      { header: 'Material', weight: 1.6 },
      { header: 'Descripción', weight: 2.2 },
      { header: 'Color', weight: 1.0 },
      { header: 'Mayoreo', weight: 1.1 },
      { header: 'Público', weight: 1.1 },
      { header: 'ICCID', weight: 2.2 },
      { header: 'Número', weight: 1.2 },
      { header: 'Estatus', weight: 1.0 },
      { header: 'Ubicación', weight: 1.6 },
    ];

    const totalWeight = columns.reduce((a, c) => a + c.weight, 0);
    columns.forEach(c => {
      c.width = Math.floor((c.weight / totalWeight) * usableWidth);
    });
    columns[columns.length - 1].width += usableWidth - columns.reduce((a, c) => a + c.width, 0);

    const rowHeight = 26;
    const headerHeight = 26;

    function drawPageHeader() {
      const logoX = (pageWidth - logoW) / 2;
      doc.image(logoPath, logoX, 14, { width: logoW });

      doc.fontSize(22).fillColor('#000000').text('Inventario ACCELMAR', 0, 58, { align: 'center' });

      const gen = fmtFechaES(new Date());
      const scope = esAdmin ? 'TODAS LAS UBICACIONES' : `UBICACIÓN: ${req.user.ubicacion}`;

      doc.fontSize(10).fillColor('#555555').text(`Generado: ${gen}`, 0, 83, { align: 'center' });
      doc.fontSize(10).fillColor('#555555').text(scope, 0, 98, { align: 'center' });

      doc.moveTo(left, 112).lineTo(right, 112).strokeColor('#DDDDDD').stroke();
    }

    function drawTableHeader(y) {
      let x = left;
      columns.forEach(col => {
        doc.rect(x, y, col.width, headerHeight).fillAndStroke('#EDEDED', '#000000');
        doc.fillColor('#000000').fontSize(10).text(col.header, x + 6, y + 8, {
          width: col.width - 12,
        });
        x += col.width;
      });
      return y + headerHeight;
    }

    function drawRow(y, item, idx) {
      const tableWidth = columns.reduce((a, c) => a + c.width, 0);

      if (idx % 2 === 0) {
        doc.rect(left, y, tableWidth, rowHeight).fill('#FAFAFA');
      }

      const est = normalizeLower(item.estatus);
      const estatusColor = est === 'vendido' ? '#FF4D4D' : '#2ECC71';

      const row = [
        item.material || '',
        item.descripcion || '',
        item.color || '',
        item.precio_mayoreo != null ? money(item.precio_mayoreo) : '',
        item.precio_publico != null ? money(item.precio_publico) : '',
        item.iccid || '',
        item.numero || '',
        (item.estatus || '').toUpperCase(),
        item.ubicacion_actual || '',
      ];

      let x = left;
      row.forEach((text, i) => {
        doc.rect(x, y, columns[i].width, rowHeight).stroke();
        doc.fillColor(columns[i].header === 'Estatus' ? estatusColor : '#000000');
        doc.fontSize(9).text(String(text), x + 6, y + 8, {
          width: columns[i].width - 12,
          lineBreak: false,
          ellipsis: true,
        });
        x += columns[i].width;
      });

      return y + rowHeight;
    }

    drawPageHeader();
    let y = 125;
    y = drawTableHeader(y);

    for (let i = 0; i < inventario.length; i++) {
      if (y + rowHeight > pageHeight - 40) {
        doc.addPage({ margin: 22, size: 'A4', layout: 'landscape' });
        drawPageHeader();
        y = 125;
        y = drawTableHeader(y);
      }
      y = drawRow(y, inventario[i], i);
    }

    doc.fontSize(8).fillColor('#777777')
      .text('Documento generado por ACCELMAR Inventario', 0, pageHeight - 28, { align: 'center' });

    doc.end();
  } catch (error) {
    console.error('❌ Error GET /inventario/pdf:', error);
    res.status(500).json({ message: 'Error al generar PDF', error: error.message });
  }
});

/** =========================
 * POST /inventario/excel
 * form-data:
 *  - file: archivo .xlsx
 *
 * Reglas:
 *  - solo super_admin, admin, control
 * ========================= */
router.post('/excel', authenticateToken, upload.single('file'), async (req, res) => {
  const client = await pool.connect();

  try {
    if (!isAdminControl(req.user.rol)) {
      safeDeleteFile(req.file?.path);
      return res.status(403).json({ message: 'No tienes permisos para cargar inventario' });
    }

    if (!req.file) {
      return res.status(400).json({ message: 'Archivo requerido. Envia form-data con key "file"' });
    }

    const workbook = xlsx.readFile(req.file.path, { raw: false });
    const sheetName = workbook.SheetNames[0];
    const sheet = workbook.Sheets[sheetName];
    const rows = xlsx.utils.sheet_to_json(sheet, { defval: null });

    if (!rows.length) {
      safeDeleteFile(req.file.path);
      return res.status(400).json({ message: 'El Excel no tiene filas' });
    }

    const required = [
      'material',
      'descripcion',
      'color',
      'cantidad',
      'precio_mayoreo',
      'precio_publico',
      'iccid',
      'numero',
      'estatus',
      'ubicacion_actual',
    ];

    const headers = Object.keys(rows[0] || {}).map(h => String(h).trim());
    const missingHeaders = required.filter(r => !headers.includes(r));

    if (missingHeaders.length) {
      safeDeleteFile(req.file.path);
      return res.status(400).json({
        message: 'Faltan columnas requeridas en el Excel',
        missingHeaders,
        headers_detectados: headers,
      });
    }

    const insertRows = [];
    const rechazados = [];

    const materialesExcel = new Set();
    const iccidsExcel = new Set();
    const numerosExcel = new Set();

    for (let i = 0; i < rows.length; i++) {
      const r = rows[i] || {};
      const fila = i + 2;

      const material = normalizeText(r.material);
      const descripcion = normalizeText(r.descripcion);
      const color = normalizeText(r.color);
      const cantidad = Number(r.cantidad || 0);
      const precio_mayoreo = Number(r.precio_mayoreo || 0);
      const precio_publico = Number(r.precio_publico || 0);
      const iccid = normalizeText(r.iccid);
      const numero = normalizeText(r.numero);
      const estatus = normalizeLower(r.estatus);
      const ubicacion_actual = normalizeText(r.ubicacion_actual);
      const comentarios = r.comentarios != null ? normalizeText(r.comentarios) : null;

      const errores = [];

      if (!material) errores.push('material vacío');
      if (!descripcion) errores.push('descripcion vacía');
      if (!color) errores.push('color vacío');
      if (!iccid) errores.push('iccid vacío');
      if (!numero) errores.push('numero vacío');
      if (!ubicacion_actual) errores.push('ubicacion_actual vacía');

      if (!Number.isFinite(cantidad) || cantidad <= 0) errores.push('cantidad inválida');
      if (!Number.isFinite(precio_mayoreo) || precio_mayoreo < 0) errores.push('precio_mayoreo inválido');
      if (!Number.isFinite(precio_publico) || precio_publico < 0) errores.push('precio_publico inválido');

      if (!['disponible', 'vendido'].includes(estatus)) {
        errores.push('estatus inválido (usa disponible|vendido)');
      }

      if (material && materialesExcel.has(material)) errores.push('material duplicado dentro del mismo Excel');
      if (iccid && iccidsExcel.has(iccid)) errores.push('iccid duplicado dentro del mismo Excel');
      if (numero && numerosExcel.has(numero)) errores.push('numero duplicado dentro del mismo Excel');

      if (errores.length) {
        rechazados.push({
          fila,
          material: material || null,
          iccid: iccid || null,
          numero: numero || null,
          errores,
        });
        continue;
      }

      materialesExcel.add(material);
      iccidsExcel.add(iccid);
      numerosExcel.add(numero);

      insertRows.push({
        fila,
        material,
        descripcion,
        color,
        cantidad,
        precio_mayoreo,
        precio_publico,
        iccid,
        numero,
        estatus,
        ubicacion_actual,
        comentarios,
      });
    }

    if (!insertRows.length) {
      safeDeleteFile(req.file.path);
      return res.status(400).json({
        message: 'No hay filas válidas para insertar',
        rechazados_count: rechazados.length,
        rechazados,
      });
    }

    const materiales = insertRows.map(r => r.material);
    const iccids = insertRows.map(r => r.iccid);
    const numeros = insertRows.map(r => r.numero);

    const [materialesBDRes, iccidsBDRes, numerosBDRes] = await Promise.all([
      client.query(`SELECT material FROM inventario_v2 WHERE material = ANY($1::text[])`, [materiales]),
      client.query(`SELECT iccid FROM inventario_v2 WHERE iccid = ANY($1::text[])`, [iccids]),
      client.query(`SELECT numero FROM inventario_v2 WHERE numero = ANY($1::text[])`, [numeros]),
    ]);

    const materialesBD = new Set(materialesBDRes.rows.map(r => r.material));
    const iccidsBD = new Set(iccidsBDRes.rows.map(r => r.iccid));
    const numerosBD = new Set(numerosBDRes.rows.map(r => r.numero));

    const insertables = [];

    for (const r of insertRows) {
      const errores = [];

      if (materialesBD.has(r.material)) errores.push('material ya existe en la base de datos');
      if (iccidsBD.has(r.iccid)) errores.push('iccid ya existe en la base de datos');
      if (numerosBD.has(r.numero)) errores.push('numero ya existe en la base de datos');

      if (errores.length) {
        rechazados.push({
          fila: r.fila,
          material: r.material,
          iccid: r.iccid,
          numero: r.numero,
          errores,
        });
        continue;
      }

      insertables.push(r);
    }

    if (!insertables.length) {
      safeDeleteFile(req.file.path);
      return res.status(400).json({
        message: 'Todas las filas fueron rechazadas por validaciones de base de datos',
        recibidos: rows.length,
        validos_excel: insertRows.length,
        insertados: 0,
        rechazados_count: rechazados.length,
        rechazados,
      });
    }

    await client.query('BEGIN');

    const insertados = [];

    for (const r of insertables) {
      const ins = await client.query(
        `
        INSERT INTO inventario_v2
          (material, descripcion, color, cantidad, precio_mayoreo, precio_publico, iccid, numero, estatus, ubicacion_actual, comentarios)
        VALUES
          ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
        RETURNING material
        `,
        [
          r.material,
          r.descripcion,
          r.color,
          r.cantidad,
          r.precio_mayoreo,
          r.precio_publico,
          r.iccid,
          r.numero,
          r.estatus,
          r.ubicacion_actual,
          r.comentarios,
        ]
      );

      insertados.push(ins.rows[0].material);

      await client.query(
        `
        INSERT INTO auditoria (usuario_id, material, accion, detalle)
        VALUES ($1, $2, $3, $4)
        `,
        [req.user.id, r.material, 'inventario_import', `excel | ubicacion=${r.ubicacion_actual}`]
      );
    }

    await client.query('COMMIT');
    safeDeleteFile(req.file.path);

    res.json({
      message: 'Excel procesado correctamente',
      archivo: req.file.originalname,
      hoja: sheetName,
      recibidos: rows.length,
      validos_excel: insertRows.length,
      insertados: insertados.length,
      materiales_insertados: insertados,
      rechazados_count: rechazados.length,
      rechazados,
    });
  } catch (error) {
    await client.query('ROLLBACK');
    safeDeleteFile(req.file?.path);
    console.error('❌ Error POST /inventario/excel:', error);
    res.status(500).json({ message: 'Error al cargar Excel', error: error.message });
  } finally {
    client.release();
  }
});

/** =========================
 * GET /inventario
 * Filtros opcionales:
 *  - estatus=disponible|vendido
 *  - q=texto (material, descripcion, iccid, numero)
 *  - ubicacion=... (solo admin/control)
 *  - page=1
 *  - limit=20
 * ========================= */
router.get('/', authenticateToken, async (req, res) => {
  try {
    const filters = buildInventarioBase(req);
    if (filters.error) {
      return res.status(filters.error.status).json({ message: filters.error.message });
    }

    const { esAdmin, whereSql, values } = filters;

    let page = Number(req.query.page || 1);
    let limit = Number(req.query.limit || 20);

    if (!Number.isFinite(page) || page <= 0) page = 1;
    if (!Number.isFinite(limit) || limit <= 0) limit = 20;
    if (limit > 200) limit = 200;

    const offset = (page - 1) * limit;

    const totalRes = await pool.query(
      `
      SELECT COUNT(*) AS total
      FROM inventario_v2
      ${whereSql}
      `,
      values
    );

    const total = Number(totalRes.rows[0].total || 0);
    const total_pages = total === 0 ? 0 : Math.ceil(total / limit);

    const result = await pool.query(
      `
      SELECT *
      FROM inventario_v2
      ${whereSql}
      ORDER BY created_at DESC
      LIMIT $${values.length + 1}
      OFFSET $${values.length + 2}
      `,
      [...values, limit, offset]
    );

    res.json({
      message: 'Inventario cargado correctamente',
      count: result.rows.length,
      total,
      page,
      limit,
      total_pages,
      scope: esAdmin ? 'all' : 'own_ubicacion',
      inventario: result.rows,
    });
  } catch (error) {
    console.error('❌ Error GET /inventario:', error);
    res.status(500).json({ message: 'Error al obtener inventario', error: error.message });
  }
});

/** =========================
 * GET /inventario/:material
 * ========================= */
router.get('/:material', authenticateToken, async (req, res) => {
  try {
    const material = normalizeText(req.params.material);

    const result = await pool.query(
      `SELECT * FROM inventario_v2 WHERE material = $1`,
      [material]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ message: 'Material no encontrado' });
    }

    const item = result.rows[0];

    if (!canSeeItem(req.user, item)) {
      return res.status(403).json({ message: 'No tienes permisos para ver este material' });
    }

    res.json({ message: 'Material encontrado', equipo: item });
  } catch (error) {
    console.error('❌ Error GET /inventario/:material:', error);
    res.status(500).json({ message: 'Error al obtener material', error: error.message });
  }
});

/** =========================
 * PATCH /inventario/:material
 * Reglas:
 *  - admin/control: puede editar estatus, fecha_venta, comentarios y ubicacion_actual
 *  - PV: solo estatus/fecha_venta/comentarios y solo si el material está en su ubicación
 * ========================= */
router.patch('/:material', authenticateToken, async (req, res) => {
  try {
    const material = normalizeText(req.params.material);

    const { estatus, fecha_venta, comentarios, ubicacion_actual } = req.body || {};

    const estatusNorm = normalizeLower(estatus);
    const allowedStatus = ['disponible', 'vendido'];

    if (!estatusNorm) {
      return res.status(400).json({ message: 'estatus es requerido' });
    }

    if (!allowedStatus.includes(estatusNorm)) {
      return res.status(400).json({ message: 'estatus inválido. Usa disponible | vendido' });
    }

    const exists = await pool.query(
      `SELECT * FROM inventario_v2 WHERE material = $1`,
      [material]
    );

    if (exists.rows.length === 0) {
      return res.status(404).json({ message: 'Material no encontrado' });
    }

    const item = exists.rows[0];
    const esAdmin = isAdminControl(req.user.rol);

    if (!esAdmin) {
      if (!req.user.ubicacion) {
        return res.status(400).json({ message: 'Tu usuario no tiene ubicacion asignada' });
      }

      if (item.ubicacion_actual !== req.user.ubicacion) {
        return res.status(403).json({ message: 'No tienes permisos para editar este material' });
      }
    }

    if (!esAdmin && ubicacion_actual) {
      return res.status(403).json({ message: 'No puedes cambiar la ubicación del material' });
    }

    const fechaVentaFinal =
      estatusNorm === 'vendido'
        ? (fecha_venta ? new Date(fecha_venta) : new Date())
        : null;

    const comentariosFinal = comentarios != null ? String(comentarios).trim() : null;

    const update = await pool.query(
      `
      UPDATE inventario_v2
      SET estatus = $1,
          fecha_venta = $2,
          comentarios = $3,
          ubicacion_actual = COALESCE($4, ubicacion_actual)
      WHERE material = $5
      RETURNING *
      `,
      [
        estatusNorm,
        fechaVentaFinal,
        comentariosFinal,
        esAdmin ? (ubicacion_actual || null) : null,
        material,
      ]
    );

    await pool.query(
      `
      INSERT INTO auditoria (usuario_id, material, accion, detalle)
      VALUES ($1, $2, $3, $4)
      `,
      [
        req.user.id,
        material,
        'inventario_update',
        `estatus=${estatusNorm}${esAdmin && ubicacion_actual ? ` | ubicacion=${ubicacion_actual}` : ''}`,
      ]
    );

    res.json({
      message: 'Material actualizado correctamente',
      equipo: update.rows[0],
    });
  } catch (error) {
    console.error('❌ Error PATCH /inventario/:material:', error);
    res.status(500).json({ message: 'Error al actualizar material', error: error.message });
  }
});

module.exports = router;