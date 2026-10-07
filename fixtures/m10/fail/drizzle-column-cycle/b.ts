import { text } from "drizzle-orm/pg-core";
import { colsA } from "./a.js";

export const colsB = { ...colsA, b: text("b") };
