# Meshy Model Download

Site statique compatible GitHub Pages pour récupérer des liens de modèles 3D détectables depuis une page publique ou depuis un lien direct.

## Utilisation

1. Déposez ce dossier dans un dépôt GitHub.
2. Activez GitHub Pages sur la branche voulue.
3. Ouvrez le site publié.
4. Collez un lien de page ou un lien direct vers un modèle 3D.

Le scanner direct fonctionne pour les fichiers `.glb`, `.gltf`, `.obj`, `.fbx`, `.stl`, `.ply`, `.dae` et `.usdz`, ainsi que pour les pages qui autorisent la lecture cross-origin par CORS.

## Capture Meshy

L'extension d'origine pouvait s'injecter dans Meshy avec les permissions Chrome (`webRequest`, `scripting`, `downloads`). Un site GitHub Pages ne possède pas ces permissions et ne peut pas intercepter automatiquement les requêtes d'un autre domaine.

Pour les pages Meshy bloquées ou les modèles déchiffrés dans un Worker, utilisez l'onglet **Capture** du site :

1. Copiez le bookmarklet ou le script.
2. Ouvrez la page Meshy du modèle.
3. Lancez la capture depuis la page Meshy.
4. Le panneau flottant affiche les modèles détectés et les boutons de téléchargement.

Si le scanner de lien affiche un blocage navigateur pour une URL `meshy.ai`, c'est attendu : le site doit passer par **Capture**. Le script de capture filtre les faux liens présents dans le HTML de Meshy, comme `.stl`, `.USDZ`, `model.json` ou `u003e.stl`, qui ne sont pas de vrais fichiers téléchargeables.

## Fichiers

- `index.html` : interface statique.
- `styles.css` : styles responsives.
- `src/app.js` : scanner de lien, extraction d'URLs, téléchargement et export JSON.
- `src/capture.js` : capture assistée à exécuter dans l'onglet cible.
