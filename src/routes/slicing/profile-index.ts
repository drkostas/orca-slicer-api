import { promises as fs } from "fs";
import * as path from "path";
import type { ProfileCategory } from "./profile-resolver";

// Where every bundled preset lives, by name.
//
// A vendor tree is not flat. OrcaSlicer 2.4.2 keeps 944 of the 2198 BBL
// filament presets in subfolders (`filament/Polymaker/...`, `filament/COEX/...`,
// `filament/P1P/...`), and the vendor's own `BBL.json` is what maps each preset
// name to its `sub_path`. A reader that only lists `filament/*.json` never sees
// those presets, and a resolver that only tries `filament/<name>.json` silently
// drops any parent that lives in one.
//
// OrcaSlicer also ships `OrcaFilamentLibrary` next to the vendor folders: the
// third-party filaments (Elegoo, Polymaker, COEX, ...) it offers on every
// printer. Vendor presets may inherit from it -- 147 BBL filament presets have
// their `@base` there -- and it inherits from nothing outside itself. That is
// the order the slicer loads them in (PresetBundle::load_vendors), and the
// order `lookup` follows: the vendor first, then the library; once a walk has
// stepped into the library it stays there, because 104 names (`fdm_filament_pet`,
// `Bambu PETG HF @base`, ...) exist in both trees with different contents.
//
// Bambu Studio ships no library, so for its image `library` is null.

export const FILAMENT_LIBRARY = "OrcaFilamentLibrary";

export type ProfileScope = "vendor" | "library";

export interface ProfileTree {
  root: string;
  files: Record<ProfileCategory, Map<string, string>>;
}

export interface ProfileIndex {
  vendor: ProfileTree;
  library: ProfileTree | null;
}

const LIST_KEYS: Record<string, ProfileCategory> = {
  machine_list: "machine",
  process_list: "process",
  filament_list: "filament",
};

const CATEGORIES: ProfileCategory[] = ["machine", "process", "filament"];

/**
 * Index the vendor tree at ``bundledProfilesPath`` and the filament library
 * beside it.
 *
 * Not cached: the vendor manifest is one file and the three directory
 * listings are cheap next to a slice, and an uncached index can never go
 * stale against the tree it describes.
 */
export async function loadProfileIndex(
  bundledProfilesPath: string,
): Promise<ProfileIndex> {
  const vendor = await readTree(bundledProfilesPath);
  let library: ProfileTree | null = null;
  if (path.basename(bundledProfilesPath) !== FILAMENT_LIBRARY) {
    const libraryRoot = path.join(
      path.dirname(bundledProfilesPath),
      FILAMENT_LIBRARY,
    );
    if (await isDirectory(libraryRoot)) {
      library = await readTree(libraryRoot);
      // The library only contributes filaments, as in the slicer.
      library.files.machine.clear();
      library.files.process.clear();
    }
  }
  return { vendor, library };
}

/**
 * The file holding the preset ``name``, and the scope it was found in.
 *
 * ``from`` is the scope of the preset doing the inheriting: a vendor preset
 * looks in its vendor, then the library; a library preset only in the library.
 */
export function lookupProfile(
  index: ProfileIndex,
  category: ProfileCategory,
  name: string,
  from: ProfileScope = "vendor",
): { file: string; scope: ProfileScope } | null {
  if (from === "vendor") {
    const file = index.vendor.files[category].get(name);
    if (file) return { file, scope: "vendor" };
  }
  const file = index.library?.files[category].get(name);
  return file ? { file, scope: "library" } : null;
}

/**
 * Every preset file of one tree: the vendor manifest's entries first, then
 * any top-level ``<category>/*.json`` the manifest does not name.
 *
 * The flat pass keeps a tree without a manifest working exactly as before
 * (test fixtures, a hand-built BUNDLED_PROFILES_PATH), keyed by file name
 * like the old ``<category>/<name>.json`` lookup.
 */
async function readTree(root: string): Promise<ProfileTree> {
  const tree: ProfileTree = {
    root,
    files: { machine: new Map(), process: new Map(), filament: new Map() },
  };

  const manifest = await readManifest(root);
  for (const [key, category] of Object.entries(LIST_KEYS)) {
    const entries = manifest?.[key];
    if (!Array.isArray(entries)) continue;
    for (const entry of entries) {
      if (!entry || typeof entry !== "object") continue;
      const { name, sub_path: subPath } = entry as Record<string, unknown>;
      if (typeof name !== "string" || name.length === 0) continue;
      if (typeof subPath !== "string" || subPath.length === 0) continue;
      const file = path.resolve(root, subPath);
      // A manifest is data from the image, but a sub_path must still not
      // point the resolver outside the tree it belongs to.
      if (!file.startsWith(path.resolve(root) + path.sep)) continue;
      if (!tree.files[category].has(name)) tree.files[category].set(name, file);
    }
  }

  for (const category of CATEGORIES) {
    let entries: string[];
    try {
      entries = await fs.readdir(path.join(root, category));
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.endsWith(".json")) continue;
      const name = entry.slice(0, -".json".length);
      if (!tree.files[category].has(name)) {
        tree.files[category].set(name, path.join(root, category, entry));
      }
    }
  }

  return tree;
}

/** ``<vendor>.json`` next to the vendor folder, or null when absent or bad. */
async function readManifest(
  root: string,
): Promise<Record<string, unknown> | null> {
  const file = path.join(path.dirname(root), `${path.basename(root)}.json`);
  try {
    const parsed = JSON.parse(await fs.readFile(file, "utf-8"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

async function isDirectory(dir: string): Promise<boolean> {
  try {
    return (await fs.stat(dir)).isDirectory();
  } catch {
    return false;
  }
}
