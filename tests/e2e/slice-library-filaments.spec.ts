import { describe, expect, it } from "vitest";
import { request } from "./setup";
import fs from "fs";
import path from "path";
import { getDefaultBundledProfilesPath } from "../../src/routes/slicing/profile-resolver";

// The Standard tier used to read only the top level of `BBL/filament/`, which
// missed every preset the vendor keeps in a subfolder and OrcaSlicer's whole
// filament library beside it (Bambuddy #3234). These pick such presets by
// name, as Bambuddy sends them -- `{inherits: "<name>"}` and nothing else --
// and slice with them against the shipped bundle, so the inherits walk, the
// listing and the CLI all have to agree.

const SLICER_FLAVOR = process.env.SLICER_FLAVOR ?? "bambu";
const bundledPath = getDefaultBundledProfilesPath();
const shippedSuite = bundledPath ? describe : describe.skip;
// Only OrcaSlicer ships the filament library.
const librarySuite = bundledPath && SLICER_FLAVOR === "orca" ? describe : describe.skip;

const PRINTER = "Bambu Lab X1 Carbon 0.4 nozzle";
const PROCESS = "0.20mm Standard @BBL X1C";

function stub(name: string): Buffer {
  return Buffer.from(JSON.stringify({ inherits: name, from: "system" }));
}

async function sliceWith(filament: string): Promise<string> {
  const cube = fs.readFileSync(path.join(__dirname, "../files/input/Cube.stl"));
  const res = await request
    .post("/slice")
    .attach("file", cube, "Cube.stl")
    .attach("printerProfile", stub(PRINTER), "printer.json")
    .attach("presetProfile", stub(PROCESS), "process.json")
    .attach("filamentProfile", stub(filament), "filament.json")
    .buffer(true)
    .parse((r, cb) => {
      let data = "";
      r.setEncoding("utf8");
      r.on("data", (chunk: string) => (data += chunk));
      r.on("end", () => cb(null, data));
    })
    .expect(200);
  return res.body as string;
}

function header(gcode: string, key: string): string | undefined {
  return gcode.match(new RegExp(`^; ${key} = (.*)$`, "m"))?.[1];
}

/**
 * An X1C PLA the vendor manifest places in a subfolder. PLA, because the
 * default plate is the Cool Plate, which the slicer refuses for e.g. PA-CF.
 */
function subfolderFilament(): string | undefined {
  const manifest = JSON.parse(
    fs.readFileSync(path.join(bundledPath as string, "..", "BBL.json"), "utf-8"),
  ) as { filament_list: Array<{ name: string; sub_path: string }> };
  return manifest.filament_list.find(
    (e) =>
      e.sub_path.split("/").length > 2 &&
      e.name.endsWith("@BBL X1C") &&
      / PLA\b/.test(e.name),
  )?.name;
}

shippedSuite("presets kept in a vendor subfolder", () => {
  it("are listed and slice with their own settings", async () => {
    const name = subfolderFilament();
    expect(name).toBeDefined();

    const listing = await request.get("/profiles/bundled").expect(200);
    const entry = listing.body.filament.find((f: { name: string }) => f.name === name);
    expect(entry?.compatible_printers).toContain(PRINTER);

    const gcode = await sliceWith(name as string);
    expect(header(gcode, "filament_settings_id")).toBe(`"${name}"`);
  });
});

librarySuite("OrcaSlicer filament library presets", () => {
  it("are offered on Bambu printers", async () => {
    const listing = await request.get("/profiles/bundled").expect(200);
    const elegoo = listing.body.filament.find(
      (f: { name: string }) => f.name === "Elegoo PLA @System",
    );
    expect(elegoo?.filament_type).toBe("PLA");
    expect(elegoo?.compatible_printers).toContain(PRINTER);
  });

  it("slice with the library preset's settings", async () => {
    const gcode = await sliceWith("Elegoo PLA @System");
    expect(header(gcode, "filament_settings_id")).toBe('"Elegoo PLA @System"');
    expect(header(gcode, "filament_vendor")).toBe("Elegoo");
    expect(header(gcode, "nozzle_temperature")).toBe("210");
  });
});
