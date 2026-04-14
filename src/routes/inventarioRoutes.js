const express = require('express')
const router = express.Router()
const PDFDocument = require('pdfkit')
const authenticateToken = require('../middlewares/authMiddleware')
const pool = require('../config/database')
const path = require('path')
const fs = require('fs')
const multer = require('multer')
const ExcelJS = require('exceljs')

/** =========================
 * Config
 * ========================= */
const ROLES_ADMIN = ['super_admin', 'admin', 'control']

const upload = multer({
  dest: path.join(__dirname, '../uploads'),
  limits: { fileSize: 10 * 1024 * 1024 },
})

/** =========================
 * Helpers
 * ========================= */
const isAdmin = (rol) => ROLES_ADMIN.includes(rol)
const normalize = (v) => String(v || '').trim()
const lower = (v) => normalize(v).toLowerCase()

/** =========================
 * 🔥 MAPEO EXCEL → DB
 * ========================= */
const COLUMN_MAP = {
  FACTURA: 'factura',
  MATERIAL: 'material',
  DESCRIPCION: 'descripcion',
  COLOR: 'color',
  CANTIDAD: 'cantidad',
  DISTRIBUIDOR: 'precio_mayoreo',
  PUBLICO: 'precio_publico',
  FECHA_COMPRA: 'fecha_compra',
  IMEI: 'imei',
  IMEI_2: 'imei_2',
  ICCID: 'iccid',
  NUMERO: 'numero',
  CLIENTE: 'cliente',
  COMENTARIOS: 'comentarios',
}

const normalizeRow = (row) => {
  const newRow = {}

  for (const key in row) {
    const cleanKey = key.trim().toUpperCase()
    if (COLUMN_MAP[cleanKey]) {
      newRow[COLUMN_MAP[cleanKey]] = row[key]
    }
  }

  return newRow
}

/** =========================
 * 🔥 UBICACIONES
 * ========================= */
router.get('/ubicaciones', async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT DISTINCT ubicacion_actual
      FROM inventario_v2
      WHERE ubicacion_actual IS NOT NULL
      ORDER BY ubicacion_actual
    `)

    res.json(result.rows.map(r => r.ubicacion_actual))
  } catch {
    res.status(500).json({ message: 'Error obteniendo ubicaciones' })
  }
})

/** =========================
 * GET INVENTARIO
 * ========================= */
router.get('/', authenticateToken, async (req, res) => {
  try {
    const { estatus, q, ubicacion } = req.query
    const esAdmin = isAdmin(req.user.rol)

    const where = []
    const values = []

    if (!esAdmin) {
      where.push(`ubicacion_actual = $${values.length + 1}`)
      values.push(req.user.ubicacion)
    } else if (ubicacion) {
      where.push(`ubicacion_actual = $${values.length + 1}`)
      values.push(ubicacion)
    }

    if (estatus) {
      where.push(`LOWER(estatus) = $${values.length + 1}`)
      values.push(lower(estatus))
    }

    if (q) {
      where.push(`(
        material ILIKE $${values.length + 1}
        OR descripcion ILIKE $${values.length + 1}
        OR iccid ILIKE $${values.length + 1}
        OR numero ILIKE $${values.length + 1}
      )`)
      values.push(`%${q}%`)
    }

    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : ''

    const result = await pool.query(
      `
      SELECT *
      FROM inventario_v2
      ${whereSql}
      ORDER BY created_at DESC
      `,
      values
    )

    res.json({
      inventario: result.rows,
      count: result.rows.length,
    })
  } catch {
    res.status(500).json({ message: 'Error al obtener inventario' })
  }
})

/** =========================
 * GET PDF
 * ========================= */
router.get('/pdf', authenticateToken, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT * FROM inventario_v2 ORDER BY created_at DESC`
    )

    const doc = new PDFDocument({ margin: 20, size: 'A4', layout: 'landscape' })

    res.setHeader('Content-Type', 'application/pdf')
    res.setHeader('Content-Disposition', 'attachment; filename=inventario.pdf')

    doc.pipe(res)

    doc.fontSize(18).text('Inventario ACCELMAR', { align: 'center' })
    doc.moveDown()

    result.rows.forEach((item) => {
      doc.fontSize(10).text(
        `${item.material} | ${item.descripcion} | ${item.estatus} | ${item.ubicacion_actual}`
      )
    })

    doc.end()
  } catch {
    res.status(500).json({ message: 'Error PDF' })
  }
})

/** =========================
 * POST EXCEL (🔥 SEGURO)
 * ========================= */
router.post('/excel', authenticateToken, upload.single('file'), async (req, res) => {
  const filePath = req.file?.path

  try {
    if (!isAdmin(req.user.rol)) {
      return res.status(403).json({ message: 'Sin permisos' })
    }

    if (!filePath) {
      return res.status(400).json({ message: 'Archivo no recibido' })
    }

    const workbook = new ExcelJS.Workbook()
    await workbook.xlsx.readFile(filePath)

    const sheet = workbook.worksheets[0]

    const headers = []
    sheet.getRow(1).eachCell((cell, colNumber) => {
      headers[colNumber] = cell.value
    })

    const errores = []
    let insertados = 0

    for (let i = 2; i <= sheet.rowCount; i++) {
      const rowData = {}
      const row = sheet.getRow(i)

      row.eachCell((cell, colNumber) => {
        const header = headers[colNumber]
        if (header) {
          rowData[header] = cell.value
        }
      })

      try {
        const clean = normalizeRow(rowData)

        if (!clean.material) {
          errores.push({ fila: i, error: 'Sin MATERIAL' })
          continue
        }

        await pool.query(
          `
          INSERT INTO inventario_v2
          (material, descripcion, color, cantidad, precio_mayoreo, precio_publico, iccid, numero, estatus, ubicacion_actual)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
          `,
          [
            clean.material,
            clean.descripcion || 'SIN DESCRIPCION',
            clean.color || null,
            clean.cantidad || 1,
            clean.precio_mayoreo || 0,
            clean.precio_publico || 0,
            clean.iccid || null,
            clean.numero || null,
            'disponible',
            req.user.ubicacion || 'GENERAL',
          ]
        )

        insertados++
      } catch (err) {
        errores.push({ fila: i, error: err.message })
      }
    }

    res.json({
      message: 'Proceso completado',
      insertados,
      errores,
    })
  } catch (error) {
    res.status(500).json({ message: 'Error al procesar Excel' })
  } finally {
    if (filePath && fs.existsSync(filePath)) {
      fs.unlinkSync(filePath)
    }
  }
})

/** =========================
 * GET POR MATERIAL
 * ========================= */
router.get('/:material', authenticateToken, async (req, res) => {
  try {
    const { material } = req.params

    const result = await pool.query(
      `SELECT * FROM inventario_v2 WHERE material = $1`,
      [material]
    )

    if (!result.rows.length) {
      return res.status(404).json({ message: 'No encontrado' })
    }

    res.json(result.rows[0])
  } catch {
    res.status(500).json({ message: 'Error al obtener material' })
  }
})

/** =========================
 * PATCH
 * ========================= */
router.patch('/:material', authenticateToken, async (req, res) => {
  try {
    const { material } = req.params
    const { estatus, ubicacion_actual } = req.body

    const result = await pool.query(
      `
      UPDATE inventario_v2
      SET estatus = COALESCE($1, estatus),
          ubicacion_actual = COALESCE($2, ubicacion_actual)
      WHERE material = $3
      RETURNING *
      `,
      [estatus ? lower(estatus) : null, ubicacion_actual, material]
    )

    res.json(result.rows[0])
  } catch {
    res.status(500).json({ message: 'Error al actualizar' })
  }
})

module.exports = router