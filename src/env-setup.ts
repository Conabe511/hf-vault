import { config } from "dotenv";
import { applyHFConfig } from "./utils/hfconf";

// This module MUST be the first import of the entry point: ES module
// semantics evaluate imported modules before the importer's body, so a
// plain config() call in index.ts would run AFTER modules that read
// process.env at load time.
//
// Layering: .env in the current directory (development only) wins,
// then .hfconf (the installed app's editable configuration) fills the gaps.
config({ quiet: true });
applyHFConfig();
