require('dotenv').config();
const pool = require('./config/database');
const { v4: uuidv4 } = require('uuid');

async function seed() {
  try {
    const equipos = [
      {
        tienda: 'tienda1', equipo: 'Samsung', modelo: 'S21', precio_distribuidor: 450, precio_venta: 550,
        iccid: '89520202020202004597', numero_asignado: '2311550530', estatus: 'disponible', color: 'Blanco'
      },
      {
        tienda: 'tienda1', equipo: 'Samsung', modelo: 'S21', precio_distribuidor: 450, precio_venta: 550,
        iccid: '89520202020202004598', numero_asignado: '2311550531', estatus: 'vendido', fecha_venta: new Date(), comentarios: 'Vendido por Ana', color: 'Negro'
      },
      {
        tienda: 'tienda2', equipo: 'iPhone', modelo: '13 Pro', precio_distribuidor: 650, precio_venta: 800,
        iccid: '89520202020202004599', numero_asignado: '2311550532', estatus: 'disponible', color: 'Gris'
      },
      {
        tienda: 'tienda2', equipo: 'iPhone', modelo: '13 Pro', precio_distribuidor: 650, precio_venta: 800,
        iccid: '89520202020202004600', numero_asignado: '2311550533', estatus: 'vendido', fecha_venta: new Date(), comentarios: 'Vendido por Luis', color: 'Azul'
      },
      {
        tienda: 'tienda3', equipo: 'Motorola', modelo: 'G10', precio_distribuidor: 200, precio_venta: 250,
        iccid: '89520202020202004601', numero_asignado: '2311550534', estatus: 'disponible', color: 'Negro'
      },
      {
        tienda: 'tienda3', equipo: 'Motorola', modelo: 'G10', precio_distribuidor: 200, precio_venta: 250,
        iccid: '89520202020202004602', numero_asignado: '2311550535', estatus: 'vendido', fecha_venta: new Date(), comentarios: 'Vendido por Maria', color: 'Blanco'
      },
      {
        tienda: 'tienda1', equipo: 'Xiaomi', modelo: 'Redmi 10', precio_distribuidor: 150, precio_venta: 200,
        iccid: '89520202020202004603', numero_asignado: '2311550536', estatus: 'disponible', color: 'Azul'
      },
      {
        tienda: 'tienda2', equipo: 'Xiaomi', modelo: 'Redmi 10', precio_distribuidor: 150, precio_venta: 200,
        iccid: '89520202020202004604', numero_asignado: '2311550537', estatus: 'vendido', fecha_venta: new Date(), comentarios: 'Vendido por Pedro', color: 'Negro'
      },
      {
        tienda: 'tienda3', equipo: 'Samsung', modelo: 'A52', precio_distribuidor: 300, precio_venta: 350,
        iccid: '89520202020202004605', numero_asignado: '2311550538', estatus: 'disponible', color: 'Blanco'
      }
    ];

    for (const eq of equipos) {
      await pool.query(`
        INSERT INTO inventario (
          id, tienda, equipo, modelo, precio_distribuidor, precio_venta, iccid, numero_asignado, estatus, fecha_venta, comentarios, color
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
      `, [
        uuidv4(), eq.tienda, eq.equipo, eq.modelo, eq.precio_distribuidor,
        eq.precio_venta, eq.iccid, eq.numero_asignado, eq.estatus, eq.fecha_venta || null, eq.comentarios || null, eq.color
      ]);
    }

    console.log('✅ 9 equipos agregados al inventario');
    process.exit();

  } catch (err) {
    console.error(err);
    process.exit(1);
  }
}

seed();
