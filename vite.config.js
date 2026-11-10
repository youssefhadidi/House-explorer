import { defineConfig } from 'vite';
import fs from 'node:fs';
import path from 'node:path';

// Dossiers scannés pour trouver les maquettes (relatifs à la racine du projet).
const MODEL_DIRS = ['.', 'models'];
const MODEL_RE = /\.(glb|gltf)$/i;
const VIRTUAL_ID = 'virtual:house-models';
const RESOLVED_ID = '\0' + VIRTUAL_ID;

/**
 * - expose la liste des maquettes via `import models from 'virtual:house-models'`
 * - en dev, prévient le navigateur (événement `house:models`) quand un fichier
 *   .glb/.gltf est ajouté, modifié ou supprimé : la vue se recharge sans perdre la caméra
 * - au build, copie les maquettes dans dist/
 */
function houseModels() {
  let root = process.cwd();

  const listModels = () => {
    const out = [];
    for (const dir of MODEL_DIRS) {
      const abs = path.resolve(root, dir);
      if (!fs.existsSync(abs)) continue;
      for (const file of fs.readdirSync(abs).sort((a, b) => a.localeCompare(b))) {
        if (!MODEL_RE.test(file)) continue;
        const rel = dir === '.' ? file : `${dir}/${file}`;
        out.push({ name: rel, url: '/' + rel });
      }
    }
    return out;
  };

  const isModelFile = (file) => {
    if (!MODEL_RE.test(file)) return false;
    const relDir = path.relative(root, path.dirname(file)) || '.';
    return MODEL_DIRS.includes(relDir.split(path.sep).join('/'));
  };

  return {
    name: 'house-models',
    configResolved(config) {
      root = config.root;
    },
    resolveId(id) {
      if (id === VIRTUAL_ID) return RESOLVED_ID;
    },
    load(id) {
      if (id === RESOLVED_ID) return `export default ${JSON.stringify(listModels())};`;
    },
    configureServer(server) {
      const timers = new Map();
      const notify = (kind) => (file) => {
        if (!isModelFile(file)) return;
        // un export Python écrit le fichier en plusieurs fois : on attend qu'il soit stable
        clearTimeout(timers.get(file));
        timers.set(file, setTimeout(() => {
          timers.delete(file);
          const mod = server.moduleGraph.getModuleById(RESOLVED_ID);
          if (mod) server.moduleGraph.invalidateModule(mod);
          const changed = '/' + path.relative(root, file).split(path.sep).join('/');
          server.ws.send({ type: 'custom', event: 'house:models', data: { kind, changed, list: listModels() } });
        }, 300));
      };
      server.watcher.on('add', notify('add'));
      server.watcher.on('change', notify('change'));
      server.watcher.on('unlink', notify('unlink'));
    },
    handleHotUpdate({ file }) {
      if (MODEL_RE.test(file)) return []; // géré par l'événement ci-dessus, pas de rechargement de page
    },
    generateBundle() {
      for (const m of listModels()) {
        this.emitFile({ type: 'asset', fileName: m.url.slice(1), source: fs.readFileSync(path.resolve(root, m.url.slice(1))) });
      }
    },
  };
}

export default defineConfig({
  plugins: [houseModels()],
  server: { open: true },
  build: { chunkSizeWarningLimit: 1500 }, // three.js pèse ~700 ko, c'est normal
});
