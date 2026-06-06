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

Pour les pages Meshy bloquées ou les modèles déchiffrés dans un Worker, utilisez l'onglet **Capture** du site.

### Méthode recommandée : script persistant

1. Installez Tampermonkey ou Violentmonkey.
2. Ouvrez `src/meshy-capture.user.js` depuis le site GitHub Pages.
3. Installez le script.
4. Rechargez la page Meshy du modèle.
5. Le panneau **Meshy True Capture** s'affiche sur Meshy et capture les blobs GLB déchiffrés par le Worker.

Cette méthode réplique la logique importante de l'extension : hook `Worker`, `fetch` et `URL.createObjectURL` à `document-start`, avant que Meshy charge le modèle.

Si Meshy affiche une erreur en boucle après installation, supprimez l'ancienne version du script dans Tampermonkey puis installez la version `1.0.1` ou plus récente. Les hooks restent actifs à `document-start`, mais le panneau visuel attend maintenant que le DOM Meshy soit prêt pour ne pas casser l'hydratation de l'application.

### Méthode de secours : bookmarklet

1. Copiez le bookmarklet ou le script.
2. Ouvrez la page Meshy du modèle.
3. Lancez la capture depuis la page Meshy.
4. Le panneau flottant affiche les modèles détectés et les boutons de téléchargement.

Le bookmarklet peut arriver trop tard si Meshy a déjà créé son Worker. Dans ce cas, il ne peut pas voir le vrai modèle de la page.

Si le scanner de lien affiche un blocage navigateur pour une URL `meshy.ai`, c'est attendu : le site doit passer par **Capture**. Le script de capture filtre les faux liens présents dans le HTML de Meshy, comme `.stl`, `.USDZ`, `model.json` ou `u003e.stl`, qui ne sont pas de vrais fichiers téléchargeables.

## Fichiers

- `index.html` : interface statique.
- `styles.css` : styles responsives.
- `src/app.js` : scanner de lien, extraction d'URLs, téléchargement et export JSON.
- `src/capture.js` : capture assistée à exécuter dans l'onglet cible.
- `src/meshy-capture.user.js` : script utilisateur à `document-start`, recommandé pour capturer le vrai modèle Meshy.
