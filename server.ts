import express from "express";
import { createServer as createViteServer } from "vite";
import path from "path";
import Database from "better-sqlite3";
import multer from "multer";
import { GoogleGenAI, Type } from "@google/genai";
import { Parser } from "json2csv";
import ExcelJS from "exceljs";
import Papa from "papaparse";
import bcrypt from "bcrypt";
import jwt from "jsonwebtoken";
import cookieParser from "cookie-parser";
import crypto from "crypto";
import { fileURLToPath } from "url";
import { validateCSVHeaders } from "./packages/validator/csv.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const isProd = process.env.NODE_ENV === "production";
const PORT = 3000;
const JWT_SECRET = process.env.JWT_SECRET || "fallback_secret_for_dev";

if (JWT_SECRET === "fallback_secret_for_dev") {
  if (isProd) {
    console.error("FATAL: JWT_SECRET is using the fallback value in production. This is a critical security risk.");
    process.exit(1);
  } else {
    console.warn("WARNING: JWT_SECRET is using the fallback value. Do not use this in production.");
  }
}

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY || "" });

// Database Setup
const db = new Database("capmap.db");
db.pragma("journal_mode = WAL");

// Initialize Tables
db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    email TEXT UNIQUE,
    password_hash TEXT,
    role TEXT
  );

  CREATE TABLE IF NOT EXISTS it_assets (
    id TEXT PRIMARY KEY,
    name TEXT,
    type TEXT,
    environment TEXT
  );

  CREATE TABLE IF NOT EXISTS capabilities (
    id TEXT PRIMARY KEY,
    name TEXT,
    domain TEXT,
    maturity_level INTEGER,
    owner TEXT,
    linked_system_ids TEXT,
    cost_center TEXT,
    sla_target_ms INTEGER,
    last_reviewed DATETIME
  );

  CREATE TABLE IF NOT EXISTS processes (
    id TEXT PRIMARY KEY,
    name TEXT,
    owner TEXT,
    domain TEXT,
    capability_id TEXT,
    FOREIGN KEY(capability_id) REFERENCES capabilities(id)
  );

  CREATE TABLE IF NOT EXISTS relationships (
    id TEXT PRIMARY KEY,
    source_id TEXT,
    source_type TEXT,
    target_id TEXT,
    target_type TEXT,
    relationship_type TEXT
  );

  CREATE TABLE IF NOT EXISTS metrics (
    id TEXT PRIMARY KEY,
    capability_id TEXT,
    prompt_hash TEXT,
    kpi_json TEXT,
    timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(capability_id) REFERENCES capabilities(id)
  );

  CREATE TABLE IF NOT EXISTS visualizations (
    id TEXT PRIMARY KEY,
    user_id TEXT,
    prompt TEXT,
    image_data TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS capability_snapshots (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id TEXT,
    snapshot_date TEXT UNIQUE,
    avg_maturity REAL
  );

  CREATE TABLE IF NOT EXISTS interaction_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id TEXT,
    event_type TEXT,
    entity_type TEXT,
    entity_id TEXT,
    metadata_json TEXT,
    timestamp DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS demo_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id TEXT,
    event_type TEXT,
    step INTEGER,
    timestamp DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS generation_usage (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id TEXT,
    date TEXT,
    count INTEGER,
    UNIQUE(user_id, date)
  );

  -- Seed Data
  INSERT OR IGNORE INTO capabilities (id, name, domain, maturity_level) VALUES 
  ('cap1', 'Strategic Planning', 'Strategy', 4),
  ('cap2', 'Supply Chain Management', 'Operations', 3),
  ('cap3', 'Customer Relationship Management', 'Sales', 5),
  ('cap4', 'Financial Reporting', 'Finance', 4),
  ('cap5', 'Talent Acquisition', 'HR', 2);
`);

const upload = multer({ storage: multer.memoryStorage() });

async function startServer() {
  const app = express();
  app.use(express.json());
  app.use(cookieParser());

  // Auth Middleware
  const authMiddleware = (req: express.Request, res: express.Response, next: express.NextFunction) => {
    if (req.path === "/api/auth/login") return next();
    if (!req.path.startsWith("/api/")) return next();
    
    const token = req.cookies.token;
    if (!token) return res.status(401).json({ error: "Unauthorized" });
    try {
      const decoded = jwt.verify(token, JWT_SECRET) as any;
      (req as any).user = decoded;
      next();
    } catch (err) {
      return res.status(401).json({ error: "Invalid token" });
    }
  };
  app.use(authMiddleware);

  // --- API Routes ---

  // Auth Mock (Simplified for MVP)
  app.post("/api/auth/login", async (req, res, next) => {
    try {
      const { email } = req.body;
      let user = db.prepare("SELECT * FROM users WHERE email = ?").get(email) as any;
      if (!user) {
        const id = Math.random().toString(36).substring(7);
        const password_hash = await bcrypt.hash("default_password", 10);
        db.prepare("INSERT INTO users (id, email, password_hash, role) VALUES (?, ?, ?, ?)").run(id, email, password_hash, "user");
        user = { id, email, role: "user" };
      }
      const token = jwt.sign({ id: user.id, email: user.email, role: user.role }, JWT_SECRET, { expiresIn: "24h" });
      res.cookie("token", token, { httpOnly: true, secure: true, sameSite: "none" });
      res.json({ id: user.id, email: user.email, role: user.role });
    } catch (err) {
      next(err);
    }
  });

  // Capabilities
  app.get("/api/capabilities", (req, res) => {
    const caps = db.prepare("SELECT * FROM capabilities").all();
    res.json(caps);
  });

  app.post("/api/capabilities", (req, res) => {
    const { name, domain, maturity_level } = req.body;
    const id = Math.random().toString(36).substring(7);
    db.prepare("INSERT INTO capabilities (id, name, domain, maturity_level) VALUES (?, ?, ?, ?)").run(id, name, domain, maturity_level);
    res.json({ id, name, domain, maturity_level });
  });

  // Metrics Generation
  app.post("/api/metrics/generate", async (req, res, next) => {
    try {
      const { capabilityId } = req.body;
      const userId = (req as any).user.id;
      
      // Quota Check
      const today = new Date().toISOString().split("T")[0];
      let usage = db.prepare("SELECT count FROM generation_usage WHERE user_id = ? AND date = ?").get(userId, today) as any;
      if (usage && usage.count >= 50) {
        return res.status(429).json({ error: "Daily AI generation limit reached. Please try again after 24 hours." });
      }

      const capability = db.prepare("SELECT * FROM capabilities WHERE id = ?").get(capabilityId) as any;
      if (!capability) return res.status(404).json({ error: "Capability not found" });

      let extraContext = "";
      if (capability.cost_center) extraContext += `\nCost Center: ${capability.cost_center}`;
      if (capability.sla_target_ms) extraContext += `\nSLA Target: ${capability.sla_target_ms}ms`;
      if (capability.owner) extraContext += `\nOwner: ${capability.owner}`;

      const prompt = `Generate 8 business metrics for a capability named "${capability.name}" in the "${capability.domain}" domain. ${extraContext}
      Include 5 KPIs and 3 Advanced Metrics. 
      Return ONLY a JSON array of objects with "name", "value", "unit", and "trend" (up/down/stable).
      Constraints: Values must be realistic numbers. Units should be appropriate (%, $, hours, etc.).`;

      const promptHash = crypto.createHash("sha256").update(prompt).digest("hex");

      // Cache Check (24h TTL)
      const cached = db.prepare("SELECT * FROM metrics WHERE capability_id = ? AND prompt_hash = ? AND timestamp >= datetime('now', '-1 day') ORDER BY timestamp DESC LIMIT 1").get(capabilityId, promptHash) as any;
      if (cached) {
        return res.json(JSON.parse(cached.kpi_json));
      }

      // Gemini Call
      const response = await ai.models.generateContent({
        model: "gemini-3-flash-preview",
        contents: prompt,
        config: {
          responseMimeType: "application/json",
          responseSchema: {
            type: Type.ARRAY,
            items: {
              type: Type.OBJECT,
              properties: {
                name: { type: Type.STRING },
                value: { type: Type.NUMBER },
                unit: { type: Type.STRING },
                trend: { type: Type.STRING }
              },
              required: ["name", "value", "unit", "trend"]
            }
          }
        }
      });

      const metricsJson = response.text;
      const id = Math.random().toString(36).substring(7);
      db.prepare("INSERT INTO metrics (id, capability_id, prompt_hash, kpi_json) VALUES (?, ?, ?, ?)").run(id, capabilityId, promptHash, metricsJson);
      
      // Update usage
      if (usage) {
        db.prepare("UPDATE generation_usage SET count = count + 1 WHERE user_id = ? AND date = ?").run(userId, today);
      } else {
        db.prepare("INSERT INTO generation_usage (user_id, date, count) VALUES (?, ?, 1)").run(userId, today);
      }

      res.json(JSON.parse(metricsJson));
    } catch (error: any) {
      console.error(error);
      res.status(500).json({ error: "Failed to generate metrics", details: error.message });
    }
  });

  // Dashboard
  app.get("/api/dashboard", (req, res) => {
    const totalCapabilities = db.prepare("SELECT COUNT(*) as count FROM capabilities").get() as any;
    const totalSystems = db.prepare("SELECT COUNT(*) as count FROM it_assets").get() as any;
    const avgMaturity = db.prepare("SELECT AVG(maturity_level) as avg FROM capabilities").get() as any;
    
    const today = new Date().toISOString().split("T")[0];
    const userId = (req as any).user?.id || "anonymous";
    db.prepare("INSERT INTO capability_snapshots (user_id, snapshot_date, avg_maturity) SELECT ?, ?, ? WHERE NOT EXISTS (SELECT 1 FROM capability_snapshots WHERE snapshot_date = ?)").run(userId, today, avgMaturity.avg || 0, today);


    // Mocking some chart data based on real counts for simplicity, or we can aggregate
    const domainDistribution = db.prepare("SELECT domain as name, COUNT(*) as value FROM capabilities GROUP BY domain").all();
    
    const snapshots = db.prepare("SELECT snapshot_date as name, avg_maturity as value FROM capability_snapshots ORDER BY snapshot_date ASC").all() as any[];

    res.json({
      metrics: {
        totalCapabilities: totalCapabilities.count,
        totalSystems: totalSystems.count,
        avgMaturity: avgMaturity.avg ? avgMaturity.avg.toFixed(1) : 0,
        criticalGaps: 3 // Mocked for now
      },
      charts: {
        domainDistribution: domainDistribution.length ? domainDistribution : [{ name: 'None', value: 0 }],
        maturityTrend: [
          ...snapshots,
          { name: 'Current', value: avgMaturity.avg ? parseFloat(avgMaturity.avg.toFixed(1)) : 0 }
        ]
      }
    });
  });

  // Visualizations
  app.post("/api/visualizations", async (req, res, next) => {
    try {
      const { prompt } = req.body;
      const userId = (req as any).user.id;

      const response = await ai.models.generateContent({
        model: "gemini-2.5-flash-image",
        contents: {
          parts: [{ text: `Create a professional business architecture diagram for: ${prompt}. Style: Clean, enterprise, blueprint.` }]
        },
        config: {
          imageConfig: {
            aspectRatio: "16:9"
          }
        }
      });
      
      let imageData = null;
      for (const part of response.candidates?.[0]?.content?.parts || []) {
        if (part.inlineData) {
          imageData = `data:image/png;base64,${part.inlineData.data}`;
          break;
        }
      }

      if (imageData) {
        const id = Math.random().toString(36).substring(7);
        db.prepare("INSERT INTO visualizations (id, user_id, prompt, image_data) VALUES (?, ?, ?, ?)").run(id, userId, prompt, imageData);
        res.json({ id, prompt, imageData });
      } else {
        res.status(500).json({ error: "Failed to generate image" });
      }
    } catch (error) {
      console.error(error);
      res.status(500).json({ error: "Failed to generate visualization" });
    }
  });

  app.get("/api/visualizations", (req, res) => {
    const userId = (req as any).user.id;
    const history = db.prepare("SELECT * FROM visualizations WHERE user_id = ? ORDER BY created_at DESC").all(userId);
    res.json(history);
  });

  // Interaction Logging
  app.post("/api/user/interactions", (req, res) => {
    const { userId, eventType, entityType, entityId, metadata } = req.body;
    db.prepare("INSERT INTO interaction_events (user_id, event_type, entity_type, entity_id, metadata_json) VALUES (?, ?, ?, ?, ?)")
      .run(userId, eventType, entityType, entityId, JSON.stringify(metadata));
    res.json({ status: "ok" });
  });

  // Demo Endpoints
  app.post("/api/demo/event", (req, res) => {
    const { userId, eventType, step } = req.body;
    db.prepare("INSERT INTO demo_events (user_id, event_type, step) VALUES (?, ?, ?)")
      .run(userId, eventType, step);
    res.json({ status: "ok" });
  });

  app.post("/api/demo/load", (req, res) => {
    const csvString = `IT System,Capability,Business Process,Owner,Environment
Salesforce,Customer Management,Lead Processing,Sales,SaaS
AWS Lambda,Order Processing,Checkout Fulfillment,Engineering,Cloud
Snowflake,Analytics,Reporting,Data,Cloud
Stripe,Payment Processing,Billing,Finance,SaaS
Legacy CRM,Customer Management,Account Updates,Sales,On-Prem`;

    const parsed = Papa.parse(csvString, { header: true, skipEmptyLines: true });
    const rows = parsed.data as any[];
    let inserted = 0;

    const insertCap = db.prepare("INSERT OR IGNORE INTO capabilities (id, name, domain, maturity_level) VALUES (?, ?, ?, ?)");
    const insertAsset = db.prepare("INSERT OR IGNORE INTO it_assets (id, name, type, environment) VALUES (?, ?, ?, ?)");
    const insertProcess = db.prepare("INSERT OR IGNORE INTO processes (id, name, owner, domain, capability_id) VALUES (?, ?, ?, ?, ?)");
    const insertRel = db.prepare("INSERT OR IGNORE INTO relationships (id, source_id, source_type, target_id, target_type, relationship_type) VALUES (?, ?, ?, ?, ?, ?)");
    const insertMetric = db.prepare("INSERT OR REPLACE INTO metrics (capability_id, kpi_json) VALUES (?, ?)");

    db.transaction(() => {
      for (const row of rows) {
        const assetName = row["IT System"];
        const capName = row["Capability"];
        const processName = row["Business Process"];
        const owner = row["Owner"];
        const env = row["Environment"];

        if (!capName) continue;

        const capId = `cap_${capName.replace(/[^a-zA-Z0-9]/g, "_").toLowerCase()}`;
        insertCap.run(capId, capName, "Demo", 3);

        if (assetName) {
          const assetId = `asset_${assetName.replace(/[^a-zA-Z0-9]/g, "_").toLowerCase()}`;
          insertAsset.run(assetId, assetName, "System", env || "Production");
          
          const relId = `rel_${assetId}_${capId}`;
          insertRel.run(relId, assetId, "it_asset", capId, "capability", "supports");
        }

        if (processName) {
          const processId = `proc_${processName.replace(/[^a-zA-Z0-9]/g, "_").toLowerCase()}`;
          insertProcess.run(processId, processName, owner || "Unknown", "Demo", capId);
        }
        
        inserted++;
      }

      // Pre-compute metrics for demo
      const custMgmtMetrics = [
        { name: "Operational Efficiency", value: 45, unit: "%", description: "Low efficiency due to overlapping systems." },
        { name: "Automation Ratio", value: 30, unit: "%", description: "Manual sync required between Salesforce and Legacy CRM." },
        { name: "System Coupling", value: 0.82, unit: "Index", description: "High coupling between modern and legacy systems." },
        { name: "Failure Surface", value: 85, unit: "Risk Score", description: "High risk due to Legacy CRM dependencies." },
        { name: "Latency Risk", value: 70, unit: "Risk Score", description: "Data sync delays." },
        { name: "Strategic Importance", value: 95, unit: "Score", description: "Critical for revenue generation." },
        { name: "Modernization Priority", value: 100, unit: "Score", description: "Urgent need to retire Legacy CRM." },
        { name: "Value Contribution", value: 80, unit: "Score", description: "High value, but hampered by tech debt." }
      ];
      insertMetric.run("cap_customermanagement", JSON.stringify(custMgmtMetrics));

      const orderProcMetrics = [
        { name: "Operational Efficiency", value: 92, unit: "%", description: "Highly efficient serverless architecture." },
        { name: "Automation Ratio", value: 98, unit: "%", description: "Fully automated via AWS Lambda." },
        { name: "System Coupling", value: 0.15, unit: "Index", description: "Loosely coupled microservices." },
        { name: "Failure Surface", value: 10, unit: "Risk Score", description: "Low risk, highly resilient." },
        { name: "Latency Risk", value: 5, unit: "Risk Score", description: "Real-time processing." },
        { name: "Strategic Importance", value: 90, unit: "Score", description: "Core operational capability." },
        { name: "Modernization Priority", value: 10, unit: "Score", description: "Already modernized." },
        { name: "Value Contribution", value: 95, unit: "Score", description: "Directly drives fulfillment." }
      ];
      insertMetric.run("cap_orderprocessing", JSON.stringify(orderProcMetrics));
    })();

    res.json({ success: true, rowsProcessed: inserted });
  });

  // Sample CSV Download
  app.get("/api/sample.csv", (req, res) => {
    const csvContent = "Capability,IT System,Business Process,Owner,Environment\nCustomer Management,Salesforce,Lead Processing,Sales,SaaS\nOrder Fulfillment,AWS Lambda,Checkout Processing,Operations,Cloud\n";
    res.setHeader("Content-Type", "text/csv");
    res.setHeader("Content-Disposition", 'attachment; filename="sample.csv"');
    res.send(csvContent);
  });

  // Upload Dataset (Bulk Capabilities)
  app.post("/api/capabilities/bulk", upload.single("file"), (req, res) => {
    const file = (req as any).file;
    if (!file) return res.status(400).json({ error: "No file uploaded" });
    
    if (!file.originalname.toLowerCase().endsWith('.csv')) {
      return res.status(400).json({ error: "File must be a .csv" });
    }
    
    const csvString = file.buffer.toString("utf-8");
    if (!csvString.trim()) {
      return res.status(400).json({ error: "CSV is empty" });
    }

    const parsed = Papa.parse(csvString, { header: true, skipEmptyLines: true });
    
    if (parsed.errors.length > 0 && parsed.errors[0].code !== 'TooFewFields') {
      return res.status(400).json({ error: "Invalid CSV format", details: parsed.errors });
    }

    const validation = validateCSVHeaders(parsed.meta.fields || []);
    if (!validation.isValid) {
      return res.status(400).json({ error: validation.error });
    }

    const rows = parsed.data as any[];
    if (rows.length === 0) {
      return res.status(400).json({ error: "CSV must contain at least one row of data" });
    }

    let inserted = 0;

    const insertCap = db.prepare("INSERT OR REPLACE INTO capabilities (id, name, domain, maturity_level, owner, linked_system_ids, cost_center, sla_target_ms, last_reviewed) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)");
    const insertAsset = db.prepare("INSERT OR IGNORE INTO it_assets (id, name, type, environment) VALUES (?, ?, ?, ?)");
    const insertProcess = db.prepare("INSERT OR IGNORE INTO processes (id, name, owner, domain, capability_id) VALUES (?, ?, ?, ?, ?)");
    const insertRel = db.prepare("INSERT OR IGNORE INTO relationships (id, source_id, source_type, target_id, target_type, relationship_type) VALUES (?, ?, ?, ?, ?, ?)");

    try {
      db.transaction(() => {
        for (const row of rows) {
          // Find the actual header key that matches case-insensitively
          const capKey = Object.keys(row).find(k => k.trim().toLowerCase() === 'capability' || k.trim().toLowerCase() === 'name');
          if (!capKey) continue;
          
          const capName = row[capKey]?.trim();
          if (!capName) continue;

          // Map other optional columns
          const domainKey = Object.keys(row).find(k => k.trim().toLowerCase() === 'domain');
          const domain = domainKey ? row[domainKey] : "Imported";
          
          const ownerKey = Object.keys(row).find(k => k.trim().toLowerCase() === 'owner');
          const owner = ownerKey ? row[ownerKey] : "";
          
          const systemKey = Object.keys(row).find(k => k.trim().toLowerCase() === 'it system');
          const systemName = systemKey ? row[systemKey]?.trim() : "";

          const processKey = Object.keys(row).find(k => k.trim().toLowerCase() === 'business process');
          const processName = processKey ? row[processKey]?.trim() : "";

          const envKey = Object.keys(row).find(k => k.trim().toLowerCase() === 'environment');
          const env = envKey ? row[envKey]?.trim() : "Production";

          const capId = `cap_${capName.replace(/[^a-zA-Z0-9]/g, "_").toLowerCase()}`;
          insertCap.run(capId, capName, domain || "Imported", 1, owner, systemName, "", 0, new Date().toISOString());
          
          if (systemName) {
            const assetId = `asset_${systemName.replace(/[^a-zA-Z0-9]/g, "_").toLowerCase()}`;
            insertAsset.run(assetId, systemName, "System", env || "Production");
            
            const relId = `rel_${assetId}_${capId}`;
            insertRel.run(relId, assetId, "it_asset", capId, "capability", "supports");
          }

          if (processName) {
            const processId = `proc_${processName.replace(/[^a-zA-Z0-9]/g, "_").toLowerCase()}`;
            insertProcess.run(processId, processName, owner || "Unknown", domain || "Imported", capId);
          }

          inserted++;
        }

        const today = new Date().toISOString().split("T")[0];
        const userId = (req as any).user?.id || "anonymous";
        const avgMaturityResult = db.prepare("SELECT AVG(maturity_level) as avg FROM capabilities").get() as any;
        const avgMaturity = avgMaturityResult.avg || 0;
        db.prepare("INSERT INTO capability_snapshots (user_id, snapshot_date, avg_maturity) VALUES (?, ?, ?) ON CONFLICT(snapshot_date) DO UPDATE SET avg_maturity = excluded.avg_maturity, user_id = excluded.user_id").run(userId, today, avgMaturity);
      })();
    } catch (err: any) {
      return res.status(500).json({ error: "Failed to process rows", details: err.message });
    }

    if (inserted === 0) {
      return res.status(400).json({ error: "No valid capability rows found to insert" });
    }

    res.json({ success: true, rowsProcessed: inserted });
  });

  // Export
  app.post("/api/export", async (req, res, next) => {
    try {
      const { type } = req.body;
      
      // Fetch capabilities and their metrics
      const data = db.prepare(`
        SELECT c.name as Capability, c.domain as Domain, c.maturity_level as Maturity, m.kpi_json as Metrics
        FROM capabilities c
        LEFT JOIN metrics m ON c.id = m.capability_id
      `).all() as any[];

      const formattedData = data.map(row => {
        const base: any = {
          Capability: row.Capability,
          Domain: row.Domain,
          Maturity: row.Maturity
        };
        if (row.Metrics) {
          try {
            const metrics = JSON.parse(row.Metrics);
            metrics.forEach((m: any) => {
              base[m.name] = `${m.value} ${m.unit}`;
            });
          } catch (e) {}
        }
        return base;
      });

      if (type === "csv") {
        const parser = new Parser();
        const csv = parser.parse(formattedData.length > 0 ? formattedData : [{ Message: "No data available" }]);
        res.header("Content-Type", "text/csv");
        res.attachment("export.csv");
        return res.send(csv);
      } else if (type === "xlsx") {
        const workbook = new ExcelJS.Workbook();
        const sheet = workbook.addWorksheet("Metrics");
        if (formattedData.length > 0) {
          sheet.columns = Object.keys(formattedData[0]).map(k => ({ header: k, key: k }));
          formattedData.forEach(row => sheet.addRow(row));
        } else {
          sheet.columns = [{ header: "Message", key: "Message" }];
          sheet.addRow({ Message: "No data available" });
        }
        res.header("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
        res.attachment("export.xlsx");
        await workbook.xlsx.write(res);
        return res.end();
      }
      res.status(400).send("Unsupported format");
    } catch (err) {
      next(err);
    }
  });

  // --- Vite Integration ---
  if (!isProd) {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else {
    app.use(express.static(path.resolve(__dirname, "dist")));
    app.get("*", (req, res) => {
      res.sendFile(path.resolve(__dirname, "dist/index.html"));
    });
  }

  // Global Error Handler
  app.use((err: any, req: express.Request, res: express.Response, next: express.NextFunction) => {
    console.error(err);
    res.status(500).json({ error: "Internal Server Error", details: err.message });
  });

  app.listen(PORT, "0.0.0.0", () => {
    console.log(`Server running on http://localhost:${PORT}`);
  });
}

startServer();
