const jwt = require('jsonwebtoken');

function authenticateToken(req, res, next) {
  try {

    // 1️⃣ Obtener header Authorization
    const authHeader = req.headers.authorization;

    if (!authHeader) {
      return res.status(401).json({
        message: 'Token no proporcionado'
      });
    }

    // 2️⃣ Verificar formato Bearer
    const parts = authHeader.split(' ');

    if (parts.length !== 2 || parts[0] !== 'Bearer') {
      return res.status(401).json({
        message: 'Formato de token inválido. Use: Bearer <token>'
      });
    }

    const token = parts[1];

    // 3️⃣ Verificar token
    const decoded = jwt.verify(token, process.env.JWT_SECRET);

    if (!decoded || !decoded.id) {
      return res.status(403).json({
        message: 'Token inválido'
      });
    }

    // 4️⃣ Guardar usuario en request
    req.user = {
      id: decoded.id,
      email: decoded.email,
      rol: decoded.rol,
      ubicacion: decoded.ubicacion
    };

    next();

  } catch (error) {

    if (error.name === 'TokenExpiredError') {
      return res.status(403).json({
        message: 'Token expirado'
      });
    }

    if (error.name === 'JsonWebTokenError') {
      return res.status(403).json({
        message: 'Token inválido'
      });
    }

    console.error('❌ Error en autenticación:', error);

    return res.status(500).json({
      message: 'Error al verificar autenticación'
    });
  }
}

module.exports = authenticateToken;