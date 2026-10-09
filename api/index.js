// Entry point serverless da Vercel: expoe o Express app do server.js como
// handler de Function. Todas as rotas /api e o SPA estatico passam por aqui
// via vercel.json (rewrite /(.*) -> /api/index).
const { app } = require('../server');

module.exports = app;