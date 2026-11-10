# House Explorer

Visionneuse Three.js pour naviguer dans les maquettes `.glb` / `.gltf` de la maison :
vue maquette étage par étage (avec coupe horizontale façon plan) et visite à la première personne.

## Lancer

```bash
npm install      # une seule fois
npm run dev      # ouvre http://localhost:5173
```

Les maquettes sont lues à la racine du projet et dans `models/`. Elles apparaissent dans la liste
déroulante en haut à gauche. **Quand un fichier est réécrit (export Python), la vue se recharge
toute seule** en gardant la caméra, ou la position de visite. On peut aussi glisser-déposer
n'importe quel `.glb`/`.gltf` dans la fenêtre.

`npm run build` produit une version statique dans `dist/` (maquettes comprises), à servir avec
n'importe quel serveur web.

## Commandes

| Mode | Action |
|---|---|
| Maquette | glisser : tourner · clic droit : déplacer · molette : zoom |
| Maquette | **double-clic sur un sol** : démarrer la visite à cet endroit |
| Les deux | `PgPréc` / `PgSuiv` ou panneau de gauche : changer d'étage · `Tab` : changer de mode · `H` : aide |
| Les deux | `+` / `−` : heure du soleil |
| Visite | `ZQSD` (WASD) / `↑↓` : avancer · `←→` : tourner · souris : regarder · `Maj` : courir |
| Visite | clic sur la mini-carte : s'y rendre · `Échap` : libérer la souris, 2ᵉ `Échap` : maquette |

### Sur téléphone ou tablette

| Mode | Geste |
|---|---|
| Maquette | 1 doigt : tourner · 2 doigts : zoom et déplacement · **toucher deux fois un sol** : visiter |
| Visite | **joystick** en bas à gauche : avancer (pousser un peu = marcher lentement) · glisser ailleurs : regarder (les deux en même temps) · toucher la mini-carte : s'y rendre |
| Les deux | bouton ☀ : réglages (soleil, coupe) en feuille coulissante sur petit écran |

Pour l'ouvrir depuis le téléphone sur le même Wi-Fi : `npm run dev -- --host`, puis l'adresse « Network » affichée.

## Soleil

Le panneau **Soleil** simule l'ensoleillement réel :

- 4 périodes : solstice d'hiver (21 déc), équinoxes de printemps (20 mars) et d'automne (22 sept), solstice d'été (21 juin)
- l'heure se règle au curseur (5 h – 22 h 30) ou avec `+` / `−` (pas de 30 min). Le bouton ▶ anime la journée.
- la piste du curseur montre la nuit (gris) et le jour (jaune, plus vif vers midi solaire)

La position du soleil est calculée avec l'algorithme NOAA, à environ 0,5° près, en **heure légale française**
(UTC+1 en hiver et au printemps, UTC+2 en été et en automne). Par défaut on est au centre de la France
(46° N, 2° E). Le lieu se règle dans « Lieu et orientation » ou dans la maquette via les extras de la scène
`latitude` / `longitude`.

**Orientation** : `extras.azimut_haut` de la scène glTF est lu comme l'azimut (degrés depuis le nord, sens
horaire) du **haut du plan**, c'est-à-dire de la direction −Z de la maquette, qui est aussi le haut de la
mini-carte. La boussole (en bas à droite) et la flèche N de la mini-carte permettent de vérifier. Si le nord
est à l'envers, ajoute 180°.

## Déplacements

En visite, on monte et descend les escaliers à pied (on franchit jusqu'à 45 cm d'un pas, ce qui permet d'aborder un escalier par le côté). Les murs, cloisons et
garde-corps vitrés bloquent le passage. Il faut une ouverture d'au moins ~45 cm de large et 1,70 m de haut.

## Conventions de nommage reconnues

Ce sont celles de `models/maison (3).gltf` :

- un nœud par niveau : `niveau-S`, `niveau-0`, `niveau-1`… (S → Sous-sol, 0 → RDC, n → R+n, T → Toiture)
- les sols d'un niveau : `<clé du niveau>-<pièce>`, par ex. `0-salon`, `1-suite-parentale`
  (dalle ou pan de moins de 60 cm d'épaisseur) → étiquette « Salon » + surface du dessus
  (vue de dessus, pente comprise, morceaux superposés comptés une seule fois)
- escaliers : nom ou matériau contenant `escalier`
- vitrages : matériau transparent (ne portent pas d'ombre)
- sols extérieurs (`terrasse`, `toiture`, `balcon`…) : ignorés pour calculer l'altitude du niveau
- l'altitude d'un niveau = dessus de sa plus grande dalle intérieure ; le terrain naturel = sous-face des dalles du RDC

Sans ces conventions, la maquette s'affiche comme un seul niveau et les sols sont devinés par leur forme.

## Fichiers

- `src/house.js` : analyse de la maquette (niveaux, pièces, surfaces)
- `src/physics.js` : collisions (three-mesh-bvh), marches, gravité, points de départ
- `src/sun.js` : position du soleil, lever/coucher, conversion vers le repère de la maquette
- `src/main.js` : rendu, modes, interface, mini-carte, rechargement auto
- `vite.config.js` : liste des maquettes et rechargement à chaud
