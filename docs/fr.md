# OpenEPaperLink

Amène dans Gladys les étiquettes e-paper d'un point d'accès
[OpenEPaperLink](https://openepaperlink.org), par l'API locale du point
d'accès (HTTP et websocket, sans cloud), et y affiche des textes depuis vos
scènes.

> **Jamais testé avec un vrai appareil.** Cette intégration a été écrite à
> partir de l'intégration Home Assistant du projet et du code source du
> firmware du point d'accès, et testée seulement contre un point d'accès
> simulé. Non officielle, sans lien avec le projet OpenEPaperLink.

## Ce que vous obtenez

- **Le point d'accès** : joignable ou non, l'état de sa radio, le nombre
  d'étiquettes à batterie faible et d'étiquettes en retard (comptées par le
  point d'accès).
- **Un appareil par étiquette** (identifié par son adresse MAC) : niveau de
  batterie (estimé d'après la tension : 2,2 V vaut 0 %, 2,6 V et plus 100 %),
  la température de la puce de l'étiquette, « joignable » (l'étiquette s'est
  signalée à l'heure) et son dernier contact (UTC). Une étiquette servie par
  un autre point d'accès n'a pas de valeur de batterie.
- **Action de scène « Afficher un texte sur une étiquette e-paper »** :
  choisissez l'étiquette, tapez le texte (les variables de scène marchent),
  et si vous voulez la couleur, le fond, la taille et l'alignement. Appareils
  en lecture seule : rien d'autre ne peut être commandé.

## Mise en route

1. Votre point d'accès OpenEPaperLink fonctionne et sa page web s'ouvre dans
   un navigateur (par exemple `http://192.168.1.30`). Donnez-lui une adresse
   fixe dans votre box si possible.
2. Dans Gladys, ouvrez cette intégration et saisissez cette adresse (sans
   `https://` : le point d'accès parle en HTTP simple). Il n'a pas de mot de
   passe.
3. Enregistrez. Le point d'accès et ses étiquettes apparaissent dans l'onglet
   Découverte : créez ceux que vous voulez.

## Afficher un texte

- 280 caractères au plus ; les retours à la ligne sont gardés. Le texte est
  dessiné aussi grand que l'écran le permet (ou petit, moyen, grand), centré
  ou à gauche.
- La police dessine les caractères ASCII et les accents français des
  minuscules (é, è, à, ç…) ; une majuscule accentuée est dessinée sans son
  accent, et tout autre caractère (un émoji…) s'affiche « ? ».
- Rouge et jaune seulement sur les écrans qui les ont (l'action le dit
  sinon).
- Le point d'accès garde l'image ; **l'étiquette l'affiche à son prochain
  contact** (souvent en moins d'une minute, plus pour une étiquette qui dort
  davantage). La sortie « Pris par le point d'accès » vaut vrai quand le point
  d'accès l'a acceptée.

### Jamais en rafale

- Un envoi à la fois, espacés d'au moins 2 secondes, et d'au moins 15
  secondes pour la même étiquette.
- Un texte plus récent pour une étiquette remplace celui qui l'attend encore
  (l'ancien se termine par « remplacé »).
- 10 textes au plus en attente ; un texte qui ne pourrait pas partir dans les
  25 secondes de l'action est abandonné, jamais envoyé en retard.
- « Occupé » (409) du point d'accès : les envois suivants attendent ce qu'il
  demande (5 secondes à 5 minutes). 429 ou 5xx : tout se met en pause (1
  minute à 6 heures), même après un redémarrage.
- Si le point d'accès ne répond pas à temps à un envoi, l'action dit
  « envoyé, sans confirmation » : l'étiquette peut quand même afficher le
  texte.

## Comment il lit

- La liste des étiquettes (`/get_db`) à la connexion, au plus toutes les 15
  minutes ; ensuite le websocket (`/ws`) apporte chaque contact d'étiquette
  et l'état du point d'accès au fil de l'eau.
- Une connexion perdue est retentée après 10 s, 30 s, 1, 2, puis 5 minutes ;
  jamais deux essais à moins de 10 secondes, même quand le conteneur
  redémarre. « Se reconnecter » juste après un essai ne fait rien de plus.
- Les valeurs partent vers Gladys par groupes, 240 par minute au plus ; une
  valeur inchangée n'est pas renvoyée (batterie et température le sont, toutes
  les 30 minutes, pour l'historique).

## Questions aux testeurs

Si vous avez un point d'accès, dites-nous (forum, ou un ticket sur GitHub) :
l'étiquette affiche-t-elle le texte avec la bonne taille et les bonnes
couleurs ? Au bout de combien de temps ? Le niveau de batterie et la
température correspondent-ils à la page web du point d'accès ?

## Données et vie privée

Rien ne sort de votre réseau. L'intégration ne garde dans son volume `/data`
que la liste des étiquettes (MAC, nom, type), la fin d'une pause et l'heure
du dernier essai de connexion.
