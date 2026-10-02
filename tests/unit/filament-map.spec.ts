import { describe, expect, it } from "vitest";
import {
  buildSliceArgs,
  parseFilamentMap,
} from "../../src/routes/slicing/slicing.service";
import { AppError } from "../../src/middleware/error";

const base = {
  printerPath: "/w/input/printer.json",
  presetPath: "/w/input/preset.json",
  filamentPaths: ["/w/input/filament_1.json", "/w/input/filament_2.json"],
  outputDir: "/w/output",
  inPath: "/w/input/model.3mf",
};

// The argument list the service built before filament maps existed. Kept
// literal on purpose: "no map" has to mean byte-for-byte the old command.
const legacyArgs = [
  "--export-3mf",
  "result.3mf",
  "--slice",
  "1",
  "--load-settings",
  "/w/input/printer.json;/w/input/preset.json",
  "--load-filaments",
  "/w/input/filament_1.json;/w/input/filament_2.json",
  "--curr-bed-type",
  "Textured PEI Plate",
  "--allow-newer-file",
  "--outputdir",
  "/w/output",
  "/w/input/model.3mf",
];

const settings = {
  exportType: "3mf" as const,
  bedType: "Textured PEI Plate",
};

describe("parseFilamentMap", () => {
  it("returns undefined when no map is given", () => {
    expect(parseFilamentMap({})).toBeUndefined();
  });

  it("returns undefined for an empty or blank map", () => {
    expect(parseFilamentMap({ filamentMap: "" })).toBeUndefined();
    expect(parseFilamentMap({ filamentMap: " , ; " })).toBeUndefined();
  });

  it("splits comma- and semicolon-separated extruder ids", () => {
    expect(parseFilamentMap({ filamentMap: "1,2" })).toEqual(["1", "2"]);
    expect(parseFilamentMap({ filamentMap: "2;1;1" })).toEqual([
      "2",
      "1",
      "1",
    ]);
    expect(parseFilamentMap({ filamentMap: " 1 , 2 " })).toEqual(["1", "2"]);
  });

  it("rejects a map that is not a list of 1-based extruder ids", () => {
    for (const bad of ["0,1", "1,a", "-1,2", "1.5,2", "left,right"]) {
      expect(() => parseFilamentMap({ filamentMap: bad })).toThrow(AppError);
    }
  });
});

describe("buildSliceArgs", () => {
  it("builds exactly the previous arguments when no map is given", () => {
    expect(buildSliceArgs({ ...base, settings })).toEqual(legacyArgs);
    expect(
      buildSliceArgs({ ...base, settings, filamentMap: undefined }),
    ).toEqual(legacyArgs);
    expect(buildSliceArgs({ ...base, settings, filamentMap: [] })).toEqual(
      legacyArgs,
    );
  });

  it("passes the map through as --filament-map in Manual mode", () => {
    const args = buildSliceArgs({
      ...base,
      settings,
      filamentMap: ["1", "2"],
    });
    const i = args.indexOf("--filament-map");
    expect(i).toBeGreaterThan(-1);
    expect(args[i + 1]).toBe("1,2");
    expect(args.slice(i + 2, i + 4)).toEqual(["--filament-map-mode", "Manual"]);
  });

  it("only adds the two filament-map flags, leaving the rest unchanged", () => {
    const args = buildSliceArgs({
      ...base,
      settings,
      filamentMap: ["2", "1"],
    });
    const without = args.filter(
      (a, i) =>
        !["--filament-map", "--filament-map-mode"].includes(a) &&
        !["--filament-map", "--filament-map-mode"].includes(args[i - 1]),
    );
    expect(without).toEqual(legacyArgs);
    // and the model path stays last, where the CLI expects it
    expect(args[args.length - 1]).toBe(base.inPath);
  });

  it("passes a map even when filaments come from the 3MF itself", () => {
    const args = buildSliceArgs({
      ...base,
      settings: {},
      filamentPaths: [],
      filamentMap: ["1", "2"],
    });
    expect(args).not.toContain("--load-filaments");
    expect(args).toContain("--filament-map");
  });
});
