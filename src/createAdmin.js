require('dotenv').config();
const bcrypt = require('bcrypt');
const pool = require('./config/database');

async function createAdmin() {
  try {
    const email = "administrador@acmar.com";
    const plainPassword = "AcM@r2026!X"; // luego puedes cambiarla
    const rol = "super_admin";

    const hashedPassword = await bcrypt.hash(plainPassword, 10);

    const result = await pool.query(
      `INSERT INTO usuarios (email, password, rol, activo)
       VALUES ($1, $2, $3, true)
       RETURNING id, email, rol`,
      [email, hashedPassword, rol]
    );

    console.log("✅ Administrador creado:");
    console.log(result.rows[0]);

    process.exit();
  } catch (error) {
    console.error("❌ Error creando admin:", error.message);
    process.exit(1);
  }
}

createAdmin();
