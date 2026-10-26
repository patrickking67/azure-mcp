#!/usr/bin/env node
// Stands in for the Azure CLI in tests: echoes its argv as JSON, so a test can see exactly what ran.
const args = process.argv.slice(2);
if (args.includes("--help")) { console.log(`Command\n    az ${args.filter((a) => a !== "--help").join(" ")} : fake help.`); process.exit(0); }
if (args[0] === "fail") { console.error("ERROR: boom"); process.exit(1); }
console.log(JSON.stringify({ argv: args, config_dir: process.env.AZURE_CONFIG_DIR ?? null }));
