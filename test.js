import pkg from "pg";
const { Pool } = pkg;
import dotenv from "dotenv";

dotenv.config();

const DATABASE_URL = process.env.DATABASE_URL;

console.log("Testing database connection...");
console.log("DATABASE_URL exists:", !!DATABASE_URL);
console.log(
  "DATABASE_URL format:",
  DATABASE_URL ? DATABASE_URL.substring(0, 30) + "..." : "Not set"
);

// Test 1: Basic connection
const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: {
    rejectUnauthorized: false,
  },
  connectionTimeoutMillis: 10000, // 10 second timeout
});

async function testConnection() {
  try {
    console.log("\n🔄 Testing connection...");
    const client = await pool.connect();
    console.log("✅ Connected successfully!");

    const result = await client.query("SELECT NOW()");
    console.log("✅ Query successful:", result.rows[0].now);

    client.release();

    // Test table access
    console.log("\n🔄 Testing table access...");
    const tablesResult = await pool.query(`
      SELECT table_name 
      FROM information_schema.tables 
      WHERE table_schema = 'public'
    `);
    console.log(
      "✅ Available tables:",
      tablesResult.rows.map((r) => r.table_name)
    );
  } catch (error) {
    console.error("❌ Connection failed:", error.message);
    console.error("Error code:", error.code);

    if (error.code === "ENOTFOUND") {
      console.log("\n💡 DNS Resolution failed. Try these solutions:");
      console.log("1. Check your internet connection");
      console.log("2. Try using a different DNS (8.8.8.8, 1.1.1.1)");
      console.log("3. Check if your ISP/firewall blocks Supabase");
      console.log("4. Try the connection string from Supabase dashboard again");
    }
  } finally {
    await pool.end();
  }
}

testConnection();
