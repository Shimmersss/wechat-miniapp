const mysql = require("mysql2/promise");
function createPool(options) {
  const pool = mysql.createPool({ ...options, dateStrings: ["DATE"] });
  pool.pool.on("connection", (connection) =>
    connection.query("SET time_zone = '+00:00'"),
  );
  return pool;
}
async function transaction(pool, fn) {
  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();
    const result = await fn(connection);
    await connection.commit();
    return result;
  } catch (error) {
    await connection.rollback();
    throw error;
  } finally {
    connection.release();
  }
}
async function one(db, sql, params = []) {
  const [rows] = await db.execute(sql, params);
  return rows[0] || null;
}
module.exports = { createPool, transaction, one };
