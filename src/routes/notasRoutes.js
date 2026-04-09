const express = require('express');
const router = express.Router();
const PDFDocument = require('pdfkit');
const authenticateToken = require('../middlewares/authMiddleware');
const pool = require('../config/database');
const path = require('path');

/** =========================
 * Roles / Permisos
 * ========================= */
const ROLES_ADMIN = ['super_admin', 'admin', 'control'];
const ROLES_VENTA = ['super_admin', 'admin', 'control', 'pv_propio', 'pv_mayoreo'];
const ROLES_REMISION = ['super_admin', 'admin', 'control'];

function isAdminControl(rol) {
  return ROLES_ADMIN.includes(rol);
}

/** =========================
 * Helpers
 * ========================= */
function fmtFechaES(date) {
  return new Date(date).toLocaleString('es-MX', {
    year: 'numeric',
    month: 'short',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function normalizeText(v) {
  return String(v || '').trim();
}

function normalizeTipo(v) {
  return String(v || '').trim().toLowerCase();
}

function money(n) {
  const x = Number(n || 0);
  return `$${x.toFixed(2)}`;
}

function canCreateNota(userRol, tipoNorm) {
  if (!userRol) return false;
  if (userRol === 'distribuidor') return false;
  if (tipoNorm === 'remision') return ROLES_REMISION.includes(userRol);
  if (tipoNorm === 'venta') return ROLES_VENTA.includes(userRol);
  return false;
}

function canReadNota(user, nota) {
  if (!user || !nota) return false;

  if (isAdminControl(user.rol)) return true;

  if (user.ubicacion) {
    if (nota.origen === user.ubicacion) return true;
    if (nota.destino === user.ubicacion) return true;
  }

  return nota.usuario_id === user.id;
}

function assertCreatePermission(req, res, tipoNorm) {
  if (req.user.rol === 'distribuidor') {
    res.status(403).json({ message: 'Rol distribuidor no tiene acciones habilitadas por ahora' });
    return false;
  }

  if (!canCreateNota(req.user.rol, tipoNorm)) {
    const msg =
      tipoNorm === 'remision'
        ? 'No tienes permisos para crear remisiones'
        : 'No tienes permisos para crear ventas';

    res.status(403).json({ message: msg });
    return false;
  }

  return true;
}

function buildNotasFilters(req) {
  const esAdmin = isAdminControl(req.user.rol);

  const tipo = normalizeTipo(req.query.tipo);
  const desde = normalizeText(req.query.desde);
  const hasta = normalizeText(req.query.hasta);
  const q = normalizeText(req.query.q);

  const where = [];
  const values = [];

  if (!esAdmin) {
    if (!req.user.ubicacion) {
      return {
        error: { status: 400, message: 'Tu usuario no tiene ubicacion asignada' },
      };
    }

    where.push(
      `(origen = $${values.length + 1} OR destino = $${values.length + 1} OR usuario_id = $${values.length + 2})`
    );
    values.push(req.user.ubicacion, req.user.id);
  }

  if (tipo && ['venta', 'remision'].includes(tipo)) {
    where.push(`LOWER(tipo) = $${values.length + 1}`);
    values.push(tipo);
  }

  if (desde) {
    where.push(`created_at >= $${values.length + 1}`);
    values.push(`${desde} 00:00:00`);
  }

  if (hasta) {
    where.push(`created_at <= $${values.length + 1}`);
    values.push(`${hasta} 23:59:59`);
  }

  if (q) {
    where.push(`(
      folio ILIKE $${values.length + 1}
      OR COALESCE(cliente, '') ILIKE $${values.length + 1}
      OR COALESCE(comentario, '') ILIKE $${values.length + 1}
      OR origen ILIKE $${values.length + 1}
      OR destino ILIKE $${values.length + 1}
    )`);
    values.push(`%${q}%`);
  }

  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';

  return {
    esAdmin,
    tipo,
    desde,
    hasta,
    q,
    whereSql,
    values,
  };
}

/** =========================
 * GET /notas
 * admin/control ven todo
 * PV ve notas relacionadas con su ubicación
 *
 * Filtros opcionales:
 *  - tipo=venta|remision
 *  - desde=YYYY-MM-DD
 *  - hasta=YYYY-MM-DD
 *  - q=texto
 *  - page=1
 *  - limit=20
 * ========================= */
router.get('/', authenticateToken, async (req, res) => {
  try {
    const filters = buildNotasFilters(req);
    if (filters.error) {
      return res.status(filters.error.status).json({ message: filters.error.message });
    }

    const { esAdmin, tipo, desde, hasta, q, whereSql, values } = filters;

    let page = Number(req.query.page || 1);
    let limit = Number(req.query.limit || 20);

    if (!Number.isFinite(page) || page <= 0) page = 1;
    if (!Number.isFinite(limit) || limit <= 0) limit = 20;
    if (limit > 200) limit = 200;

    const offset = (page - 1) * limit;

    const totalRes = await pool.query(
      `
      SELECT COUNT(*) AS total
      FROM notas
      ${whereSql}
      `,
      values
    );

    const total = Number(totalRes.rows[0].total || 0);
    const total_pages = total === 0 ? 0 : Math.ceil(total / limit);

    const result = await pool.query(
      `
      SELECT *
      FROM notas
      ${whereSql}
      ORDER BY created_at DESC
      LIMIT $${values.length + 1}
      OFFSET $${values.length + 2}
      `,
      [...values, limit, offset]
    );

    res.json({
      notas: result.rows,
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
        q: q || null,
      },
    });
  } catch (error) {
    console.error('❌ Error GET /notas:', error);
    res.status(500).json({ message: 'Error al listar notas', error: error.message });
  }
});

/** =========================
 * POST /notas
 * Crea nota + items + movimientos + update inventario + auditoría
 * Folio lo genera BD por trigger (folio NULL)
 * ========================= */
router.post('/', authenticateToken, async (req, res) => {
  const client = await pool.connect();

  try {
    const { tipo, origen, destino, cliente, comentario, materiales } = req.body || {};

    if (!tipo || !origen || !destino || !Array.isArray(materiales) || materiales.length === 0) {
      return res.status(400).json({ message: 'tipo, origen, destino y materiales[] son requeridos' });
    }

    const tipoNorm = normalizeTipo(tipo);
    if (!['remision', 'venta'].includes(tipoNorm)) {
      return res.status(400).json({ message: 'tipo inválido. Usa remision | venta' });
    }

    if (!assertCreatePermission(req, res, tipoNorm)) return;

    const origenNorm = normalizeText(origen);
    const destinoNorm = normalizeText(destino);
    const clienteNorm = normalizeText(cliente);
    const comentarioNorm = comentario ? String(comentario).trim() : null;

    const materialesUniq = [...new Set(materiales.map(m => String(m).trim()))].filter(Boolean);
    if (materialesUniq.length === 0) {
      return res.status(400).json({ message: 'materiales[] vacío o inválido' });
    }

    await client.query('BEGIN');

    const notaRes = await client.query(
      `
      INSERT INTO notas (folio, tipo, origen, destino, cliente, usuario_id, comentario)
      VALUES (NULL, $1, $2, $3, $4, $5, $6)
      RETURNING *
      `,
      [tipoNorm, origenNorm, destinoNorm, clienteNorm || null, req.user.id, comentarioNorm]
    );

    const nota = notaRes.rows[0];
    const folio = nota.folio;

    const invRes = await client.query(
      `
      SELECT material, descripcion, color, precio_mayoreo, precio_publico, iccid, numero, estatus, ubicacion_actual
      FROM inventario_v2
      WHERE material = ANY($1::text[])
      `,
      [materialesUniq]
    );

    const map = new Map(invRes.rows.map(r => [r.material, r]));
    const faltantes = materialesUniq.filter(m => !map.has(m));

    if (faltantes.length) {
      await client.query('ROLLBACK');
      return res.status(404).json({ message: 'Material(es) no encontrado(s)', faltantes });
    }

    if (tipoNorm === 'venta' && !isAdminControl(req.user.rol)) {
      if (!req.user.ubicacion) {
        await client.query('ROLLBACK');
        return res.status(400).json({ message: 'Tu usuario no tiene ubicacion asignada' });
      }

      const bloqueados = materialesUniq.filter(m => {
        const item = map.get(m);
        return item && item.ubicacion_actual !== req.user.ubicacion;
      });

      if (bloqueados.length) {
        await client.query('ROLLBACK');
        return res.status(403).json({
          message: 'No puedes vender materiales fuera de tu ubicación',
          tu_ubicacion: req.user.ubicacion,
          materiales_bloqueados: bloqueados,
        });
      }
    }

    for (const mat of materialesUniq) {
      const it = map.get(mat);

      await client.query(
        `
        INSERT INTO nota_items (nota_id, material, descripcion, color, precio_mayoreo, precio_publico, iccid, numero)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
        `,
        [nota.id, it.material, it.descripcion, it.color, it.precio_mayoreo, it.precio_publico, it.iccid, it.numero]
      );

      if (tipoNorm === 'venta') {
        const ubicCliente = clienteNorm ? `CLIENTE: ${clienteNorm}` : 'CLIENTE FINAL';

        await client.query(
          `
          INSERT INTO movimientos (material, tipo, origen, destino, cliente, usuario_id, comentario)
          VALUES ($1,'venta',$2,$3,$4,$5,$6)
          `,
          [it.material, origenNorm, destinoNorm, clienteNorm || null, req.user.id, `Nota ${folio}`]
        );

        await client.query(
          `
          UPDATE inventario_v2
          SET estatus='vendido', fecha_venta=now(), ubicacion_actual=$1
          WHERE material=$2
          `,
          [ubicCliente, it.material]
        );
      } else {
        await client.query(
          `
          INSERT INTO movimientos (material, tipo, origen, destino, cliente, usuario_id, comentario)
          VALUES ($1,'remision',$2,$3,NULL,$4,$5)
          `,
          [it.material, origenNorm, destinoNorm, req.user.id, `Nota ${folio}`]
        );

        await client.query(
          `
          UPDATE inventario_v2
          SET ubicacion_actual=$1
          WHERE material=$2
          `,
          [destinoNorm, it.material]
        );
      }

      await client.query(
        `
        INSERT INTO auditoria (usuario_id, material, accion, detalle)
        VALUES ($1,$2,$3,$4)
        `,
        [req.user.id, it.material, 'nota', `${tipoNorm} | folio ${folio}`]
      );
    }

    await client.query('COMMIT');

    res.json({
      message: 'Nota creada correctamente',
      nota,
    });
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('❌ Error POST /notas:', error);
    res.status(500).json({ message: 'Error al crear nota', error: error.message });
  } finally {
    client.release();
  }
});

/** =========================
 * GET /notas/:id
 * ========================= */
router.get('/:id', authenticateToken, async (req, res) => {
  try {
    const { id } = req.params;

    const notaRes = await pool.query(`SELECT * FROM notas WHERE id=$1`, [id]);
    if (notaRes.rows.length === 0) {
      return res.status(404).json({ message: 'Nota no encontrada' });
    }

    const nota = notaRes.rows[0];

    if (!canReadNota(req.user, nota)) {
      return res.status(403).json({ message: 'No tienes permisos para ver esta nota' });
    }

    const itemsRes = await pool.query(
      `SELECT * FROM nota_items WHERE nota_id=$1 ORDER BY created_at ASC`,
      [id]
    );

    res.json({
      nota,
      items: itemsRes.rows,
    });
  } catch (error) {
    console.error('❌ Error GET /notas/:id:', error);
    res.status(500).json({ message: 'Error al obtener nota', error: error.message });
  }
});

/** =========================
 * GET /notas/:id/pdf
 * ========================= */
router.get('/:id/pdf', authenticateToken, async (req, res) => {
  try {
    const { id } = req.params;

    const notaRes = await pool.query(`SELECT * FROM notas WHERE id=$1`, [id]);
    if (notaRes.rows.length === 0) {
      return res.status(404).json({ message: 'Nota no encontrada' });
    }

    const nota = notaRes.rows[0];

    if (!canReadNota(req.user, nota)) {
      return res.status(403).json({ message: 'No tienes permisos para ver esta nota' });
    }

    const itemsRes = await pool.query(
      `SELECT * FROM nota_items WHERE nota_id=$1 ORDER BY created_at ASC`,
      [id]
    );
    const items = itemsRes.rows;

    const totalEquipos = items.length;
    const totalMayoreo = items.reduce((acc, it) => acc + Number(it.precio_mayoreo || 0), 0);
    const totalPublico = items.reduce((acc, it) => acc + Number(it.precio_publico || 0), 0);

    const doc = new PDFDocument({ margin: 22, size: 'A4', layout: 'landscape' });
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename=${nota.folio}.pdf`);
    doc.pipe(res);

    const pageWidth = doc.page.width;
    const pageHeight = doc.page.height;
    const left = doc.page.margins.left;
    const right = pageWidth - doc.page.margins.right;

    const logoPath = path.join(__dirname, '../assets/logo.png');
    const logoW = 120;
    doc.image(logoPath, (pageWidth - logoW) / 2, 14, { width: logoW });

    const titulo = nota.tipo.toLowerCase() === 'venta' ? 'NOTA DE VENTA' : 'NOTA DE REMISIÓN';
    doc.fontSize(20).fillColor('#000000').text(titulo, 0, 55, { align: 'center' });

    doc.moveTo(left, 82).lineTo(right, 82).strokeColor('#DDDDDD').stroke();

    const infoTop = 95;
    const col1X = left;
    const col2X = left + 380;

    doc.fontSize(10).fillColor('#333333');

    doc.text(`Folio: ${nota.folio}`, col1X, infoTop);
    doc.text(`Fecha: ${fmtFechaES(nota.created_at)}`, col1X, infoTop + 15);
    doc.text(`Origen: ${nota.origen}`, col1X, infoTop + 30);
    doc.text(`Destino: ${nota.destino}`, col1X, infoTop + 45);

    doc.text(`Tipo: ${String(nota.tipo || '').toUpperCase()}`, col2X, infoTop);
    doc.text(`Equipos: ${totalEquipos}`, col2X, infoTop + 15);
    doc.text(`Total Mayoreo: ${money(totalMayoreo)}`, col2X, infoTop + 30);
    doc.text(`Total Público: ${money(totalPublico)}`, col2X, infoTop + 45);

    if (nota.cliente) {
      doc.text(`Cliente: ${nota.cliente}`, col2X, infoTop + 60);
    }

    if (nota.comentario) {
      doc.text(`Comentario: ${nota.comentario}`, col1X, infoTop + 65, { width: right - left });
    }

    const tableTop = 190;
    const rowHeight = 26;
    const startX = left;
    const usableWidth = pageWidth - (doc.page.margins.left + doc.page.margins.right);

    const cols = [
      { header: 'Material', weight: 1.2 },
      { header: 'Descripción', weight: 2.2 },
      { header: 'Color', weight: 0.8 },
      { header: 'Mayoreo', weight: 0.9 },
      { header: 'Público', weight: 0.9 },
      { header: 'ICCID', weight: 1.8 },
      { header: 'Número', weight: 1.1 },
    ];

    const totalWeight = cols.reduce((a, c) => a + c.weight, 0);
    cols.forEach(c => (c.width = Math.floor((c.weight / totalWeight) * usableWidth)));
    cols[cols.length - 1].width += usableWidth - cols.reduce((a, c) => a + c.width, 0);

    let x = startX;
    cols.forEach(col => {
      doc.rect(x, tableTop, col.width, rowHeight).fillAndStroke('#EFEFEF', '#000000');
      doc.fillColor('#000000').fontSize(10).text(col.header, x + 6, tableTop + 8, {
        width: col.width - 12,
      });
      x += col.width;
    });

    let y = tableTop + rowHeight;
    const tableWidth = cols.reduce((a, c) => a + c.width, 0);

    const printHeaderAgain = () => {
      let hx = startX;
      cols.forEach(col => {
        doc.rect(hx, y, col.width, rowHeight).fillAndStroke('#EFEFEF', '#000000');
        doc.fillColor('#000000').fontSize(10).text(col.header, hx + 6, y + 8, {
          width: col.width - 12,
        });
        hx += col.width;
      });
      y += rowHeight;
    };

    items.forEach((it, idx) => {
      x = startX;
      if (idx % 2 === 0) {
        doc.rect(startX, y, tableWidth, rowHeight).fill('#FAFAFA');
      }

      const row = [
        it.material || '',
        it.descripcion || '',
        it.color || '',
        it.precio_mayoreo != null ? money(it.precio_mayoreo) : '',
        it.precio_publico != null ? money(it.precio_publico) : '',
        it.iccid || '',
        it.numero || '',
      ];

      row.forEach((text, i) => {
        doc.rect(x, y, cols[i].width, rowHeight).stroke();
        doc.fillColor('#000000').fontSize(9).text(String(text), x + 6, y + 8, {
          width: cols[i].width - 12,
          lineBreak: false,
          ellipsis: true,
        });
        x += cols[i].width;
      });

      y += rowHeight;

      if (y > pageHeight - 120) {
        doc.addPage({ margin: 22, size: 'A4', layout: 'landscape' });
        y = 50;
        printHeaderAgain();
      }
    });

    const firmasY = pageHeight - 85;
    doc.strokeColor('#000000').lineWidth(1);

    doc.moveTo(left + 40, firmasY).lineTo(left + 340, firmasY).stroke();
    doc.fontSize(10).fillColor('#000000').text('Entregó', left + 170, firmasY + 6, { align: 'center' });

    doc.moveTo(left + 420, firmasY).lineTo(left + 720, firmasY).stroke();
    doc.fontSize(10).fillColor('#000000').text('Recibió', left + 550, firmasY + 6, { align: 'center' });

    doc.fontSize(8).fillColor('#777777')
      .text('Documento generado por ACCELMAR Inventario', 0, pageHeight - 30, { align: 'center' });

    doc.end();
  } catch (error) {
    console.error('❌ Error GET /notas/:id/pdf:', error);
    res.status(500).json({ message: 'Error al generar PDF', error: error.message });
  }
});

module.exports = router;