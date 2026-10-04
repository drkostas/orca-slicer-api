import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { promises as fs } from "fs";
import * as os from "os";
import * as path from "path";
import {
  loadProfileIndex,
  lookupProfile,
} from "../../src/routes/slicing/profile-index";
import { resolveProfile } from "../../src/routes/slicing/profile-resolver";
import {
  buildBundledIndex,
  type BundledFilament,
} from "../../src/routes/profiles/route";

// A miniature of OrcaSlicer's `resources/profiles/`: the BBL vendor with its
// manifest and a subfolder, and the filament library beside it. The shapes
// are the shipped ones: `COEX PETG @BBL X1C` sits in `filament/COEX/` and
// inherits its `@base` from the library; the library carries its own
// `fdm_filament_pet`, which differs from the vendor's of the same name.

let profiles: string;
let bbl: string;
let library: string;

type Profile = Record<string, unknown> & { name: string };

async function put(root: string, subPath: string, profile: Profile): Promise<void> {
  const file = path.join(root, subPath);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, JSON.stringify(profile), "utf8");
}

async function manifest(
  name: string,
  lists: Record<string, Array<{ name: string; sub_path: string }>>,
): Promise<void> {
  await fs.writeFile(
    path.join(profiles, `${name}.json`),
    JSON.stringify({ name, version: "1", ...lists }),
    "utf8",
  );
}

const X1C = "Bambu Lab X1 Carbon 0.4 nozzle";
const A1 = "Bambu Lab A1 0.4 nozzle";

async function writeTrees(): Promise<void> {
  const vendorFilaments: Profile[] = [];
  const vendorEntries: Array<{ name: string; sub_path: string }> = [];
  const addVendor = async (subPath: string, profile: Profile) => {
    await put(bbl, subPath, profile);
    vendorFilaments.push(profile);
    vendorEntries.push({ name: profile.name, sub_path: subPath });
  };

  await addVendor("filament/fdm_filament_pet.json", {
    name: "fdm_filament_pet",
    instantiation: "false",
    filament_type: ["PETG"],
    source: "vendor",
  });
  await addVendor("filament/COEX/COEX PETG @BBL X1C.json", {
    name: "COEX PETG @BBL X1C",
    inherits: "COEX PETG @base",
    instantiation: "true",
    nozzle_temperature: ["245"],
    compatible_printers: [X1C],
  });
  await addVendor("filament/Generic PLA @BBL X1C.json", {
    name: "Generic PLA @BBL X1C",
    instantiation: "true",
    filament_type: ["PLA"],
    filament_vendor: ["Generic"],
    compatible_printers: [X1C],
  });

  await put(bbl, "machine/Bambu Lab X1 Carbon 0.4 nozzle.json", {
    name: X1C,
    instantiation: "true",
  });
  await put(bbl, "machine/Bambu Lab A1 0.4 nozzle.json", {
    name: A1,
    instantiation: "true",
  });

  await manifest("BBL", {
    machine_model_list: [{ name: "Bambu Lab X1 Carbon", sub_path: "machine/Bambu Lab X1 Carbon.json" }],
    machine_list: [
      { name: X1C, sub_path: `machine/${X1C}.json` },
      { name: A1, sub_path: `machine/${A1}.json` },
    ],
    filament_list: vendorEntries,
  });

  const libEntries: Array<{ name: string; sub_path: string }> = [];
  const addLib = async (subPath: string, profile: Profile) => {
    await put(library, subPath, profile);
    libEntries.push({ name: profile.name, sub_path: subPath });
  };
  await addLib("filament/fdm_filament_pet.json", {
    name: "fdm_filament_pet",
    instantiation: "false",
    filament_type: ["PET"],
    source: "library",
  });
  await addLib("filament/fdm_filament_pla.json", {
    name: "fdm_filament_pla",
    instantiation: "false",
    filament_type: ["PLA"],
  });
  await addLib("filament/COEX/COEX PETG @base.json", {
    name: "COEX PETG @base",
    inherits: "fdm_filament_pet",
    instantiation: "false",
    filament_vendor: ["COEX 3D"],
  });
  await addLib("filament/Elegoo/Elegoo PLA @base.json", {
    name: "Elegoo PLA @base",
    inherits: "fdm_filament_pla",
    instantiation: "false",
    filament_vendor: ["Elegoo"],
  });
  await addLib("filament/Elegoo/Elegoo PLA @System.json", {
    name: "Elegoo PLA @System",
    inherits: "Elegoo PLA @base",
    instantiation: "true",
    nozzle_temperature: ["210"],
    compatible_printers: [],
  });
  await addLib("filament/Generic PLA @System.json", {
    name: "Generic PLA @System",
    inherits: "fdm_filament_pla",
    instantiation: "true",
    compatible_printers: [],
  });
  await manifest("OrcaFilamentLibrary", { filament_list: libEntries });
}

beforeEach(async () => {
  profiles = await fs.mkdtemp(path.join(os.tmpdir(), "profile-index-"));
  bbl = path.join(profiles, "BBL");
  library = path.join(profiles, "OrcaFilamentLibrary");
  await writeTrees();
});

afterEach(async () => {
  await fs.rm(profiles, { recursive: true, force: true });
});

describe("loadProfileIndex", () => {
  it("finds a preset kept in a subfolder through the vendor manifest", async () => {
    const index = await loadProfileIndex(bbl);
    expect(lookupProfile(index, "filament", "COEX PETG @BBL X1C")?.file).toBe(
      path.join(bbl, "filament/COEX/COEX PETG @BBL X1C.json"),
    );
  });

  it("falls back to the filament library for a name the vendor lacks", async () => {
    const index = await loadProfileIndex(bbl);
    expect(lookupProfile(index, "filament", "Elegoo PLA @System")).toEqual({
      file: path.join(library, "filament/Elegoo/Elegoo PLA @System.json"),
      scope: "library",
    });
  });

  it("prefers the vendor's preset when both trees have the name", async () => {
    const index = await loadProfileIndex(bbl);
    expect(lookupProfile(index, "filament", "fdm_filament_pet")?.scope).toBe("vendor");
  });

  it("keeps a library preset's lookup inside the library", async () => {
    const index = await loadProfileIndex(bbl);
    expect(lookupProfile(index, "filament", "fdm_filament_pet", "library")).toEqual({
      file: path.join(library, "filament/fdm_filament_pet.json"),
      scope: "library",
    });
    expect(lookupProfile(index, "filament", "COEX PETG @BBL X1C", "library")).toBeNull();
  });

  it("indexes a tree without a manifest by file name, as before", async () => {
    await fs.rm(path.join(profiles, "BBL.json"));
    const index = await loadProfileIndex(bbl);
    expect(lookupProfile(index, "filament", "Generic PLA @BBL X1C")?.scope).toBe("vendor");
    // Only the manifest knew about the subfolder.
    expect(lookupProfile(index, "filament", "COEX PETG @BBL X1C")).toBeNull();
  });

  it("works without a filament library beside the vendor (Bambu Studio)", async () => {
    await fs.rm(library, { recursive: true });
    const index = await loadProfileIndex(bbl);
    expect(index.library).toBeNull();
    expect(lookupProfile(index, "filament", "Elegoo PLA @System")).toBeNull();
  });

  it("takes no machine or process presets from the library", async () => {
    await put(library, "machine/Stray.json", { name: "Stray" });
    const index = await loadProfileIndex(bbl);
    expect(lookupProfile(index, "machine", "Stray")).toBeNull();
  });

  it("ignores a manifest sub_path that leaves the tree", async () => {
    await put(profiles, "outside.json", { name: "Outside" });
    await manifest("BBL", {
      filament_list: [{ name: "Outside", sub_path: "../outside.json" }],
    });
    const index = await loadProfileIndex(bbl);
    expect(lookupProfile(index, "filament", "Outside")).toBeNull();
  });
});

describe("resolveProfile across subfolders and the filament library", () => {
  it("resolves a subfolder preset whose base lives in the library", async () => {
    const resolved = await resolveProfile(
      { inherits: "COEX PETG @BBL X1C", from: "system" },
      "filament",
      { bundledProfilesPath: bbl },
    );
    expect(resolved.nozzle_temperature).toEqual(["245"]);
    expect(resolved.filament_vendor).toEqual(["COEX 3D"]);
    // The library base inherits the LIBRARY's fdm_filament_pet, not the
    // vendor's preset of the same name.
    expect(resolved.source).toBe("library");
    expect(resolved.filament_type).toEqual(["PET"]);
    expect(resolved.inherits).toBeUndefined();
  });

  it("resolves a library preset picked by name", async () => {
    const resolved = await resolveProfile(
      { inherits: "Elegoo PLA @System", from: "system" },
      "filament",
      { bundledProfilesPath: bbl },
    );
    expect(resolved.nozzle_temperature).toEqual(["210"]);
    expect(resolved.filament_vendor).toEqual(["Elegoo"]);
    expect(resolved.filament_type).toEqual(["PLA"]);
  });

  it("resolves a user's cloud preset built on a library filament", async () => {
    // The way a filament reaches Orca Cloud: saved as a user preset.
    const resolved = await resolveProfile(
      { name: "My Elegoo PLA", inherits: "Elegoo PLA @System", from: "User", nozzle_temperature: ["215"] },
      "filament",
      { bundledProfilesPath: bbl },
    );
    expect(resolved.nozzle_temperature).toEqual(["215"]);
    expect(resolved.filament_vendor).toEqual(["Elegoo"]);
  });
});

describe("buildBundledIndex", () => {
  it("lists subfolder presets with their inherited fields", async () => {
    const out = await buildBundledIndex(bbl);
    const coex = out.filament.find((f) => f.name === "COEX PETG @BBL X1C");
    expect(coex).toMatchObject({ filament_type: "PET", compatible_printers: [X1C] });
  });

  it("offers a library filament on every printer of the vendor", async () => {
    const out = await buildBundledIndex(bbl);
    const elegoo = out.filament.find((f) => f.name === "Elegoo PLA @System") as BundledFilament;
    expect(elegoo.filament_type).toBe("PLA");
    expect(elegoo.compatible_printers).toEqual([A1, X1C]);
  });

  it("drops a printer where a printer-specific preset of the material supersedes it", async () => {
    // `Generic PLA @BBL X1C` shares the alias "Generic PLA", so the slicer
    // hides the library's generic one on the X1C.
    const out = await buildBundledIndex(bbl);
    const generic = out.filament.find((f) => f.name === "Generic PLA @System");
    expect(generic?.compatible_printers).toEqual([A1]);
  });

  it("leaves out a library filament superseded on every printer", async () => {
    await put(bbl, "filament/Generic PLA @BBL A1.json", {
      name: "Generic PLA @BBL A1",
      instantiation: "true",
      compatible_printers: [A1],
    });
    await fs.rm(path.join(profiles, "BBL.json"));
    // Without the manifest the vendor is read flat; the subfolder preset
    // drops out, the rest is unchanged.
    const out = await buildBundledIndex(bbl);
    expect(out.filament.map((f) => f.name)).not.toContain("Generic PLA @System");
    expect(out.filament.map((f) => f.name)).toContain("Elegoo PLA @System");
  });

  it("reports whether a filament is a support material, through inherits", async () => {
    await put(bbl, "filament/fdm_filament_pla_support.json", {
      name: "fdm_filament_pla_support",
      instantiation: "false",
      filament_type: ["PLA"],
      filament_is_support: ["1"],
    });
    await put(bbl, "filament/Bambu Support W @BBL X1C.json", {
      name: "Bambu Support W @BBL X1C",
      inherits: "fdm_filament_pla_support",
      instantiation: "true",
      compatible_printers: [X1C],
    });
    await fs.rm(path.join(profiles, "BBL.json"));
    const out = await buildBundledIndex(bbl);
    const byName = new Map(out.filament.map((f) => [f.name, f]));
    expect(byName.get("Bambu Support W @BBL X1C")?.filament_is_support).toBe(true);
    expect(byName.get("Generic PLA @BBL X1C")?.filament_is_support).toBeNull();
  });

  it("puts support materials after real filaments, inside each group only", async () => {
    // `Bambu Support For PA/PET` states PA; sorted first it was every PA
    // plate's auto-pick. But Bambu's own support-flagged `Generic HIPS` must
    // still come before a library HIPS that isn't flagged.
    await put(bbl, "filament/Bambu Support For PA @BBL X1C.json", {
      name: "Bambu Support For PA @BBL X1C",
      instantiation: "true",
      filament_type: ["PA"],
      filament_is_support: ["1"],
      compatible_printers: [X1C],
    });
    await put(bbl, "filament/Generic PA @BBL X1C.json", {
      name: "Generic PA @BBL X1C",
      instantiation: "true",
      filament_type: ["PA"],
      compatible_printers: [X1C],
    });
    await put(bbl, "filament/Generic HIPS @BBL X1C.json", {
      name: "Generic HIPS @BBL X1C",
      instantiation: "true",
      filament_type: ["HIPS"],
      filament_is_support: ["1"],
      compatible_printers: [X1C],
    });
    await put(library, "filament/AAA HIPS @System.json", {
      name: "AAA HIPS @System",
      instantiation: "true",
      filament_type: ["HIPS"],
      compatible_printers: [],
    });
    await fs.rm(path.join(profiles, "BBL.json"));
    await fs.rm(path.join(profiles, "OrcaFilamentLibrary.json"));
    const names = (await buildBundledIndex(bbl)).filament.map((f) => f.name);
    expect(names.indexOf("Generic PA @BBL X1C")).toBeLessThan(
      names.indexOf("Bambu Support For PA @BBL X1C"),
    );
    expect(names.indexOf("Generic HIPS @BBL X1C")).toBeLessThan(
      names.indexOf("AAA HIPS @System"),
    );
  });

  it("lists printers from the manifest, not the model entries", async () => {
    const out = await buildBundledIndex(bbl);
    expect(out.printer.map((p) => p.name)).toEqual([A1, X1C]);
  });

  it("lists no library filaments without a library (Bambu Studio)", async () => {
    await fs.rm(library, { recursive: true });
    const out = await buildBundledIndex(bbl);
    expect(out.filament.map((f) => f.name)).toEqual([
      "Generic PLA @BBL X1C",
      "COEX PETG @BBL X1C",
    ]);
  });

  it("orders Bambu's own, then Generic, then other brands, the library last", async () => {
    // Bambuddy's auto-pick breaks a tie on list order. Bambu Studio keeps
    // `Bambu ABS @BBL P1P` in a subfolder and `PolyLite ABS @BBL P1P` at the
    // top, so the order is by vendor, not by folder.
    await put(bbl, "filament/P1P/Bambu ABS @BBL X1C.json", {
      name: "Bambu ABS @BBL X1C",
      instantiation: "true",
      filament_vendor: ["Bambu Lab"],
      compatible_printers: [X1C],
    });
    await put(bbl, "filament/AAA ABS @BBL X1C.json", {
      name: "AAA ABS @BBL X1C",
      instantiation: "true",
      filament_vendor: ["AAA"],
      compatible_printers: [X1C],
    });
    await manifest("BBL", {
      machine_list: [
        { name: X1C, sub_path: `machine/${X1C}.json` },
        { name: A1, sub_path: `machine/${A1}.json` },
      ],
      filament_list: [
        { name: "Bambu ABS @BBL X1C", sub_path: "filament/P1P/Bambu ABS @BBL X1C.json" },
        { name: "COEX PETG @BBL X1C", sub_path: "filament/COEX/COEX PETG @BBL X1C.json" },
      ],
    });
    const out = await buildBundledIndex(bbl);
    expect(out.filament.map((f) => f.name)).toEqual([
      "Bambu ABS @BBL X1C",
      "Generic PLA @BBL X1C",
      "AAA ABS @BBL X1C",
      "COEX PETG @BBL X1C",
      "Elegoo PLA @System",
      "Generic PLA @System",
    ]);
  });

  it("offers library filaments only on real printer presets", async () => {
    // The machine folder also holds model descriptions with no nozzle.
    await put(bbl, "machine/Bambu Lab X1 Carbon.json", {
      type: "machine_model",
      name: "Bambu Lab X1 Carbon",
    });
    await put(bbl, "machine/fdm_machine_common.json", {
      name: "fdm_machine_common",
      instantiation: "false",
    });
    const out = await buildBundledIndex(bbl);
    const elegoo = out.filament.find((f) => f.name === "Elegoo PLA @System");
    expect(elegoo?.compatible_printers).toEqual([A1, X1C]);
  });
});
