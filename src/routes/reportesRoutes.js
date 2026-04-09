const express = require('express');
const router = express.Router();
const PDFDocument = require('pdfkit');
const path = require('path');

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

function normalizeTipo(v) {
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
  if (!Number.isFinite(x)) return '$0.00';
  return `$${x.toFixed(2)}`;
}

function parsePagination(req, defaultLimit = 20, maxLimit = 200) {
  let page = Number(req.query.page || 1);
  let limit = Number(req.query.limit || defaultLimit);

  if (!Number.isFinite(page) || page <= 0) page = 1;
  if (!Number.isFinite(limit) || limit <= 0) limit = defaultLimit;
  if (limit > maxLimit) limit = maxLimit;

  const offset = (page - 1) * limit;

  return { page, limit, offset };
}

/** =========================
 * Helper: filtros de notas/ventas
 * ========================= */
function buildNotasWhere(req, { tipo, desde, hasta, ubicacion, usuarioId, q, fechaBase } = {}) {
  const esAdmin = isAdminControl(req.user.rol);
  const where = [];
  const values = [];

  // Scope por rol
  if (!esAdmin) {
    if (!req.user.ubicacion) {
      return {
        error: { status: 400, message: 'Tu usuario no tiene ubicacion asignada' },
      };
    }

    where.push(
      `(n.origen = $${values.length + 1} OR n.destino = $${values.length + 1} OR n.usuario_id = $${values.length + 2})`
    );
    values.push(req.user.ubicacion, req.user.id);
  } else {
    if (ubicacion) {
      where.push(`(n.origen = $${values.length + 1} OR n.destino = $${values.length + 1})`);
      values.push(ubicacion);
    }

    if (usuarioId) {
      where.push(`n.usuario_id = $${values.length + 1}`);
      values.push(usuarioId);
    }
  }

  if (tipo && ['venta', 'remision'].includes(tipo)) {
    where.push(`LOWER(n.tipo) = $${values.length + 1}`);
    values.push(tipo);
  }

  if (desde) {
    where.push(`n.created_at >= $${values.length + 1}`);
    values.push(`${desde} 00:00:00`);
  }

  if (hasta) {
    where.push(`n.created_at <= $${values.length + 1}`);
    values.push(`${hasta} 23:59:59`);
  }

  if (fechaBase) {
    where.push(`n.created_at >= $${values.length + 1}`);
    values.push(`${fechaBase} 00:00:00`);

    where.push(`n.created_at <= $${values.length + 1}`);
    values.push(`${fechaBase} 23:59:59`);
  }

  if (q) {
    where.push(`(
      n.folio ILIKE $${values.length + 1}
      OR COALESCE(n.cliente, '') ILIKE $${values.length + 1}
      OR COALESCE(n.comentario, '') ILIKE $${values.length + 1}
      OR n.origen ILIKE $${values.length + 1}
      OR n.destino ILIKE $${values.length + 1}
    )`);
    values.push(`%${q}%`);
  }

  return {
    esAdmin,
    whereSql: where.length ? where.join(' AND ') : '1=1',
    values,
  };
}

/** =========================
 * GET /reportes
 * ========================= */
router.get('/', (req, res) => {
  res.json({
    message: 'Módulo de reportes activo',
    endpoints: [
      'GET /reportes/ventas',
      'GET /reportes/inventario',
      'GET /reportes/corte',
      'GET /reportes/corte/pdf',
      'GET /reportes/notas',
      'GET /reportes/notas/pdf',
    ],
  });
});

/** =========================
 * GET /reportes/ventas
 * Filtros opcionales:
 *  - desde=YYYY-MM-DD
 *  - hasta=YYYY-MM-DD
 *  - ubicacion=... (solo admin/control)
 *  - usuario_id=... (solo admin/control)
 *  - page=1
 *  - limit=20
 * ========================= */
router.get('/ventas', authenticateToken, async (req, res) => {
  try {
    const desde = normalizeText(req.query.desde);
    const hasta = normalizeText(req.query.hasta);
    const ubicacion = normalizeText(req.query.ubicacion);
    const usuarioId = normalizeText(req.query.usuario_id);
    const { page, limit, offset } = parsePagination(req, 20, 200);

    const filters = buildNotasWhere(req, {
      tipo: 'venta',
      desde,
      hasta,
      ubicacion,
      usuarioId,
    });

    if (filters.error) {
      return res.status(filters.error.status).json({ message: filters.error.message });
    }

    const { esAdmin, whereSql, values } = filters;

    const totalRes = await pool.query(
      `
      SELECT COUNT(*) AS total
      FROM notas n
      WHERE ${whereSql}
      `,
      values
    );

    const total = Number(totalRes.rows[0].total || 0);
    const total_pages = total === 0 ? 0 : Math.ceil(total / limit);

    const ventasRes = await pool.query(
      `
      SELECT n.id, n.folio, n.tipo, n.origen, n.destino, n.cliente, n.usuario_id, n.comentario, n.created_at
      FROM notas n
      WHERE ${whereSql}
      ORDER BY n.created_at DESC
      LIMIT $${values.length + 1}
      OFFSET $${values.length + 2}
      `,
      [...values, limit, offset]
    );

    const totalesRes = await pool.query(
      `
      SELECT
        COUNT(DISTINCT n.id) AS total_notas,
        COUNT(ni.id) AS total_items,
        COALESCE(SUM(COALESCE(ni.precio_mayoreo,'0')::numeric), 0) AS total_mayoreo,
        COALESCE(SUM(COALESCE(ni.precio_publico,'0')::numeric), 0) AS total_publico
      FROM notas n
      LEFT JOIN nota_items ni ON ni.nota_id = n.id
      WHERE ${whereSql}
      `,
      values
    );

    const t = totalesRes.rows[0];

    res.json({
      message: 'Reporte de ventas generado correctamente',
      count: ventasRes.rows.length,
      total,
      page,
      limit,
      total_pages,
      scope: esAdmin ? 'all' : 'own_ubicacion',
      filtros: {
        desde: desde || null,
        hasta: hasta || null,
        ubicacion: esAdmin ? (ubicacion || null) : req.user.ubicacion,
        usuario_id: esAdmin ? (usuarioId || null) : req.user.id,
      },
      totales: {
        total_notas: Number(t.total_notas || 0),
        total_items: Number(t.total_items || 0),
        total_mayoreo: Number(t.total_mayoreo || 0),
        total_publico: Number(t.total_publico || 0),
      },
      ventas: ventasRes.rows,
    });
  } catch (error) {
    console.error('❌ Error GET /reportes/ventas:', error);
    res.status(500).json({
      message: 'Error al generar reporte de ventas',
      error: error.message,
    });
  }
});

/** =========================
 * GET /reportes/inventario
 * Filtros opcionales:
 *  - estatus=disponible|vendido
 *  - ubicacion=... (solo admin/control)
 *  - q=texto
 * ========================= */
router.get('/inventario', authenticateToken, async (req, res) => {
  try {
    const esAdmin = isAdminControl(req.user.rol);

    const estatus = normalizeText(req.query.estatus).toLowerCase();
    const ubicacion = normalizeText(req.query.ubicacion);
    const q = normalizeText(req.query.q);

    const where = [];
    const values = [];

    if (!esAdmin) {
      if (!req.user.ubicacion) {
        return res.status(400).json({ message: 'Tu usuario no tiene ubicacion asignada' });
      }
      where.push(`ubicacion_actual = $${values.length + 1}`);
      values.push(req.user.ubicacion);
    } else {
      if (ubicacion) {
        where.push(`ubicacion_actual = $${values.length + 1}`);
        values.push(ubicacion);
      }
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

    const inventarioRes = await pool.query(
      `
      SELECT *
      FROM inventario_v2
      ${whereSql}
      ORDER BY created_at DESC
      `,
      values
    );

    const totalesRes = await pool.query(
      `
      SELECT
        COUNT(*) AS total_items,
        COALESCE(SUM(COALESCE(precio_mayoreo,'0')::numeric), 0) AS total_mayoreo,
        COALESCE(SUM(COALESCE(precio_publico,'0')::numeric), 0) AS total_publico
      FROM inventario_v2
      ${whereSql}
      `,
      values
    );

    const t = totalesRes.rows[0];

    res.json({
      message: 'Reporte de inventario generado correctamente',
      count: inventarioRes.rows.length,
      scope: esAdmin ? 'all' : 'own_ubicacion',
      filtros: {
        estatus: estatus || null,
        ubicacion: esAdmin ? (ubicacion || null) : req.user.ubicacion,
        q: q || null,
      },
      totales: {
        total_items: Number(t.total_items || 0),
        total_mayoreo: Number(t.total_mayoreo || 0),
        total_publico: Number(t.total_publico || 0),
      },
      inventario: inventarioRes.rows,
    });
  } catch (error) {
    console.error('❌ Error GET /reportes/inventario:', error);
    res.status(500).json({
      message: 'Error al generar reporte de inventario',
      error: error.message,
    });
  }
});

/** =========================
 * GET /reportes/corte
 * Params opcionales:
 *  - fecha=YYYY-MM-DD (default hoy)
 *  - ubicacion=... (solo admin/control)
 *  - usuario_id=... (solo admin/control)
 * ========================= */
router.get('/corte', authenticateToken, async (req, res) => {
  try {
    const fecha = normalizeText(req.query.fecha);
    const ubicacion = normalizeText(req.query.ubicacion);
    const usuarioId = normalizeText(req.query.usuario_id);

    const fechaBase = fecha || new Date().toISOString().slice(0, 10);

    const filters = buildNotasWhere(req, {
      tipo: 'venta',
      ubicacion,
      usuarioId,
      fechaBase,
    });

    if (filters.error) {
      return res.status(filters.error.status).json({ message: filters.error.message });
    }

    const { esAdmin, whereSql, values } = filters;

    const ventasRes = await pool.query(
      `
      SELECT n.id, n.folio, n.origen, n.destino, n.cliente, n.usuario_id, n.comentario, n.created_at
      FROM notas n
      WHERE ${whereSql}
      ORDER BY n.created_at DESC
      `,
      values
    );

    const totalesRes = await pool.query(
      `
      SELECT
        COUNT(DISTINCT n.id) AS total_notas,
        COUNT(ni.id) AS total_items,
        COALESCE(SUM(COALESCE(ni.precio_mayoreo,'0')::numeric), 0) AS total_mayoreo,
        COALESCE(SUM(COALESCE(ni.precio_publico,'0')::numeric), 0) AS total_publico
      FROM notas n
      LEFT JOIN nota_items ni ON ni.nota_id = n.id
      WHERE ${whereSql}
      `,
      values
    );

    const t = totalesRes.rows[0];

    res.json({
      message: 'Corte generado correctamente',
      fecha: fechaBase,
      scope: esAdmin ? 'all' : 'own_ubicacion',
      filtros: {
        ubicacion: esAdmin ? (ubicacion || null) : req.user.ubicacion,
        usuario_id: esAdmin ? (usuarioId || null) : req.user.id,
      },
      resumen: {
        total_notas: Number(t.total_notas || 0),
        total_items: Number(t.total_items || 0),
        total_mayoreo: Number(t.total_mayoreo || 0),
        total_publico: Number(t.total_publico || 0),
      },
      ventas: ventasRes.rows,
    });
  } catch (error) {
    console.error('❌ Error GET /reportes/corte:', error);
    res.status(500).json({
      message: 'Error al generar corte',
      error: error.message,
    });
  }
});

/** =========================
 * GET /reportes/corte/pdf
 * ========================= */
router.get('/corte/pdf', authenticateToken, async (req, res) => {
  try {
    const fecha = normalizeText(req.query.fecha);
    const ubicacion = normalizeText(req.query.ubicacion);
    const usuarioId = normalizeText(req.query.usuario_id);

    const fechaBase = fecha || new Date().toISOString().slice(0, 10);

    const filters = buildNotasWhere(req, {
      tipo: 'venta',
      ubicacion,
      usuarioId,
      fechaBase,
    });

    if (filters.error) {
      return res.status(filters.error.status).json({ message: filters.error.message });
    }

    const { esAdmin, whereSql, values } = filters;

    const ventasRes = await pool.query(
      `
      SELECT n.id, n.folio, n.origen, n.destino, n.cliente, n.usuario_id, n.comentario, n.created_at
      FROM notas n
      WHERE ${whereSql}
      ORDER BY n.created_at DESC
      `,
      values
    );

    const totalesRes = await pool.query(
      `
      SELECT
        COUNT(DISTINCT n.id) AS total_notas,
        COUNT(ni.id) AS total_items,
        COALESCE(SUM(COALESCE(ni.precio_mayoreo,'0')::numeric), 0) AS total_mayoreo,
        COALESCE(SUM(COALESCE(ni.precio_publico,'0')::numeric), 0) AS total_publico
      FROM notas n
      LEFT JOIN nota_items ni ON ni.nota_id = n.id
      WHERE ${whereSql}
      `,
      values
    );

    const ventas = ventasRes.rows;
    const t = totalesRes.rows[0];

    const totalNotas = Number(t.total_notas || 0);
    const totalItems = Number(t.total_items || 0);
    const totalMayoreo = Number(t.total_mayoreo || 0);
    const totalPublico = Number(t.total_publico || 0);

    const doc = new PDFDocument({ margin: 22, size: 'A4', layout: 'landscape' });

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename=corte-${fechaBase}.pdf`);
    doc.pipe(res);

    const pageWidth = doc.page.width;
    const pageHeight = doc.page.height;
    const left = doc.page.margins.left;
    const right = pageWidth - doc.page.margins.right;
    const usableWidth = pageWidth - (doc.page.margins.left + doc.page.margins.right);

    const logoPath = path.join(__dirname, '../assets/logo.png');
    const logoW = 120;

    function drawPageHeader() {
      const logoX = (pageWidth - logoW) / 2;
      doc.image(logoPath, logoX, 14, { width: logoW });

      doc.fontSize(20).fillColor('#000000').text('CORTE DIARIO', 0, 55, { align: 'center' });
      doc.fontSize(10).fillColor('#555555').text(`Fecha del corte: ${fechaBase}`, 0, 80, { align: 'center' });

      const scopeText = esAdmin
        ? `ALCANCE: ${ubicacion ? ubicacion : 'TODAS LAS UBICACIONES'}`
        : `USUARIO: ${req.user.email || req.user.id}`;

      doc.fontSize(10).fillColor('#555555').text(scopeText, 0, 95, { align: 'center' });
      doc.moveTo(left, 112).lineTo(right, 112).strokeColor('#DDDDDD').stroke();
    }

    drawPageHeader();

    const infoTop = 125;
    const col1X = left;
    const col2X = left + 360;

    doc.fontSize(10).fillColor('#333333');
    doc.text(`Total notas: ${totalNotas}`, col1X, infoTop);
    doc.text(`Total equipos: ${totalItems}`, col1X, infoTop + 16);
    doc.text(`Total mayoreo: ${money(totalMayoreo)}`, col2X, infoTop);
    doc.text(`Total público: ${money(totalPublico)}`, col2X, infoTop + 16);

    const tableTop = 175;
    const rowHeight = 26;
    const headerHeight = 26;

    const columns = [
      { header: 'Folio', weight: 1.1 },
      { header: 'Fecha', weight: 1.4 },
      { header: 'Origen', weight: 1.8 },
      { header: 'Destino', weight: 1.4 },
      { header: 'Cliente', weight: 1.6 },
      { header: 'Comentario', weight: 2.0 },
    ];

    const totalWeight = columns.reduce((a, c) => a + c.weight, 0);
    columns.forEach(c => {
      c.width = Math.floor((c.weight / totalWeight) * usableWidth);
    });
    columns[columns.length - 1].width += usableWidth - columns.reduce((a, c) => a + c.width, 0);

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

    function drawRow(y, venta, idx) {
      const tableWidth = columns.reduce((a, c) => a + c.width, 0);

      if (idx % 2 === 0) {
        doc.rect(left, y, tableWidth, rowHeight).fill('#FAFAFA');
      }

      const row = [
        venta.folio || '',
        venta.created_at ? fmtFechaES(venta.created_at) : '',
        venta.origen || '',
        venta.destino || '',
        venta.cliente || '',
        venta.comentario || '',
      ];

      let x = left;
      row.forEach((text, i) => {
        doc.rect(x, y, columns[i].width, rowHeight).stroke();
        doc.fillColor('#000000').fontSize(9).text(String(text), x + 6, y + 8, {
          width: columns[i].width - 12,
          lineBreak: false,
          ellipsis: true,
        });
        x += columns[i].width;
      });

      return y + rowHeight;
    }

    let y = drawTableHeader(tableTop);

    if (ventas.length === 0) {
      doc.fontSize(11).fillColor('#666666').text('No hay ventas para este corte.', left, y + 20);
    } else {
      for (let i = 0; i < ventas.length; i++) {
        if (y + rowHeight > pageHeight - 40) {
          doc.addPage({ margin: 22, size: 'A4', layout: 'landscape' });
          drawPageHeader();
          y = drawTableHeader(125);
        }
        y = drawRow(y, ventas[i], i);
      }
    }

    doc.fontSize(8).fillColor('#777777')
      .text('Documento generado por ACCELMAR Inventario', 0, pageHeight - 28, { align: 'center' });

    doc.end();
  } catch (error) {
    console.error('❌ Error GET /reportes/corte/pdf:', error);
    res.status(500).json({
      message: 'Error al generar PDF de corte',
      error: error.message,
    });
  }
});

/** =========================
 * GET /reportes/notas
 * Filtros opcionales:
 *  - tipo=venta|remision
 *  - desde=YYYY-MM-DD
 *  - hasta=YYYY-MM-DD
 *  - ubicacion=... (solo admin/control)
 *  - usuario_id=... (solo admin/control)
 *  - q=texto
 *  - page=1
 *  - limit=20
 * ========================= */
router.get('/notas', authenticateToken, async (req, res) => {
  try {
    const tipo = normalizeTipo(req.query.tipo);
    const desde = normalizeText(req.query.desde);
    const hasta = normalizeText(req.query.hasta);
    const ubicacion = normalizeText(req.query.ubicacion);
    const usuarioId = normalizeText(req.query.usuario_id);
    const q = normalizeText(req.query.q);
    const { page, limit, offset } = parsePagination(req, 20, 200);

    const filters = buildNotasWhere(req, {
      tipo,
      desde,
      hasta,
      ubicacion,
      usuarioId,
      q,
    });

    if (filters.error) {
      return res.status(filters.error.status).json({ message: filters.error.message });
    }

    const { esAdmin, whereSql, values } = filters;

    const totalRes = await pool.query(
      `
      SELECT COUNT(*) AS total
      FROM notas n
      WHERE ${whereSql}
      `,
      values
    );

    const total = Number(totalRes.rows[0].total || 0);
    const total_pages = total === 0 ? 0 : Math.ceil(total / limit);

    const result = await pool.query(
      `
      SELECT n.*
      FROM notas n
      WHERE ${whereSql}
      ORDER BY n.created_at DESC
      LIMIT $${values.length + 1}
      OFFSET $${values.length + 2}
      `,
      [...values, limit, offset]
    );

    const resumenRes = await pool.query(
      `
      SELECT
        COUNT(*) AS total_notas,
        COUNT(*) FILTER (WHERE LOWER(n.tipo) = 'venta') AS total_ventas,
        COUNT(*) FILTER (WHERE LOWER(n.tipo) = 'remision') AS total_remisiones
      FROM notas n
      WHERE ${whereSql}
      `,
      values
    );

    const r = resumenRes.rows[0];

    res.json({
      message: 'Reporte de notas generado correctamente',
      count: result.rows.length,
      total,
      page,
      limit,
      total_pages,
      scope: esAdmin ? 'all' : 'own_ubicacion',
      filtros: {
        tipo: tipo || null,
        desde: desde || null,
        hasta: hasta || null,
        ubicacion: esAdmin ? (ubicacion || null) : req.user.ubicacion,
        usuario_id: esAdmin ? (usuarioId || null) : req.user.id,
        q: q || null,
      },
      resumen: {
        total_notas: Number(r.total_notas || 0),
        total_ventas: Number(r.total_ventas || 0),
        total_remisiones: Number(r.total_remisiones || 0),
      },
      notas: result.rows,
    });
  } catch (error) {
    console.error('❌ Error GET /reportes/notas:', error);
    res.status(500).json({
      message: 'Error al generar reporte de notas',
      error: error.message,
    });
  }
});

/** =========================
 * GET /reportes/notas/pdf
 * ========================= */
router.get('/notas/pdf', authenticateToken, async (req, res) => {
  try {
    const tipo = normalizeTipo(req.query.tipo);
    const desde = normalizeText(req.query.desde);
    const hasta = normalizeText(req.query.hasta);
    const ubicacion = normalizeText(req.query.ubicacion);
    const usuarioId = normalizeText(req.query.usuario_id);
    const q = normalizeText(req.query.q);

    let limit = Number(req.query.limit || 200);
    if (!Number.isFinite(limit) || limit <= 0) limit = 200;
    if (limit > 500) limit = 500;

    const filters = buildNotasWhere(req, {
      tipo,
      desde,
      hasta,
      ubicacion,
      usuarioId,
      q,
    });

    if (filters.error) {
      return res.status(filters.error.status).json({ message: filters.error.message });
    }

    const { esAdmin, whereSql, values } = filters;

    const notasRes = await pool.query(
      `
      SELECT n.*
      FROM notas n
      WHERE ${whereSql}
      ORDER BY n.created_at DESC
      LIMIT $${values.length + 1}
      `,
      [...values, limit]
    );

    const resumenRes = await pool.query(
      `
      SELECT
        COUNT(*) AS total_notas,
        COUNT(*) FILTER (WHERE LOWER(n.tipo) = 'venta') AS total_ventas,
        COUNT(*) FILTER (WHERE LOWER(n.tipo) = 'remision') AS total_remisiones
      FROM notas n
      WHERE ${whereSql}
      `,
      values
    );

    const notas = notasRes.rows;
    const r = resumenRes.rows[0];

    const doc = new PDFDocument({ margin: 22, size: 'A4', layout: 'landscape' });

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', 'attachment; filename=reportes-notas.pdf');
    doc.pipe(res);

    const pageWidth = doc.page.width;
    const pageHeight = doc.page.height;
    const left = doc.page.margins.left;
    const right = pageWidth - doc.page.margins.right;
    const usableWidth = pageWidth - (doc.page.margins.left + doc.page.margins.right);

    const logoPath = path.join(__dirname, '../assets/logo.png');
    const logoW = 120;

    function drawPageHeader() {
      const logoX = (pageWidth - logoW) / 2;
      doc.image(logoPath, logoX, 14, { width: logoW });

      doc.fontSize(20).fillColor('#000000').text('REPORTE DE NOTAS', 0, 55, { align: 'center' });

      const scopeText = esAdmin
        ? `ALCANCE: ${ubicacion ? ubicacion : 'TODAS LAS UBICACIONES'}`
        : `UBICACIÓN: ${req.user.ubicacion || 'N/A'}`;

      doc.fontSize(10).fillColor('#555555').text(scopeText, 0, 80, { align: 'center' });
      doc.fontSize(10).fillColor('#555555').text(
        `Filtros -> tipo: ${tipo || 'todos'} | desde: ${desde || '-'} | hasta: ${hasta || '-'} | q: ${q || '-'}`,
        0,
        95,
        { align: 'center' }
      );

      doc.moveTo(left, 112).lineTo(right, 112).strokeColor('#DDDDDD').stroke();
    }

    drawPageHeader();

    const infoTop = 125;
    const col1X = left;
    const col2X = left + 340;

    doc.fontSize(10).fillColor('#333333');
    doc.text(`Total notas: ${Number(r.total_notas || 0)}`, col1X, infoTop);
    doc.text(`Total ventas: ${Number(r.total_ventas || 0)}`, col1X, infoTop + 16);
    doc.text(`Total remisiones: ${Number(r.total_remisiones || 0)}`, col2X, infoTop);

    const tableTop = 175;
    const rowHeight = 26;
    const headerHeight = 26;

    const columns = [
      { header: 'Folio', weight: 1.1 },
      { header: 'Tipo', weight: 0.9 },
      { header: 'Fecha', weight: 1.4 },
      { header: 'Origen', weight: 1.6 },
      { header: 'Destino', weight: 1.6 },
      { header: 'Cliente', weight: 1.3 },
      { header: 'Comentario', weight: 2.1 },
    ];

    const totalWeight = columns.reduce((a, c) => a + c.weight, 0);
    columns.forEach(c => {
      c.width = Math.floor((c.weight / totalWeight) * usableWidth);
    });
    columns[columns.length - 1].width += usableWidth - columns.reduce((a, c) => a + c.width, 0);

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

    function drawRow(y, nota, idx) {
      const tableWidth = columns.reduce((a, c) => a + c.width, 0);

      if (idx % 2 === 0) {
        doc.rect(left, y, tableWidth, rowHeight).fill('#FAFAFA');
      }

      const row = [
        nota.folio || '',
        String(nota.tipo || '').toUpperCase(),
        nota.created_at ? fmtFechaES(nota.created_at) : '',
        nota.origen || '',
        nota.destino || '',
        nota.cliente || '',
        nota.comentario || '',
      ];

      let x = left;
      row.forEach((text, i) => {
        doc.rect(x, y, columns[i].width, rowHeight).stroke();
        doc.fillColor('#000000').fontSize(9).text(String(text), x + 6, y + 8, {
          width: columns[i].width - 12,
          lineBreak: false,
          ellipsis: true,
        });
        x += columns[i].width;
      });

      return y + rowHeight;
    }

    let y = drawTableHeader(tableTop);

    if (notas.length === 0) {
      doc.fontSize(11).fillColor('#666666').text('No hay notas para este reporte.', left, y + 20);
    } else {
      for (let i = 0; i < notas.length; i++) {
        if (y + rowHeight > pageHeight - 40) {
          doc.addPage({ margin: 22, size: 'A4', layout: 'landscape' });
          drawPageHeader();
          y = drawTableHeader(125);
        }
        y = drawRow(y, notas[i], i);
      }
    }

    doc.fontSize(8).fillColor('#777777')
      .text('Documento generado por ACCELMAR Inventario', 0, pageHeight - 28, { align: 'center' });

    doc.end();
  } catch (error) {
    console.error('❌ Error GET /reportes/notas/pdf:', error);
    res.status(500).json({
      message: 'Error al generar PDF de notas',
      error: error.message,
    });
  }
});

module.exports = router;