# pump.fun X watcher

Alerte instantanée (Telegram, Discord ou notification push ntfy) quand :

- **un @ de ta watchlist** (ex. `@naseem`) est vu sur pump.fun avec son compte X lié ;
- **n'importe quel compte X au-dessus d'un seuil de followers** (ex. 100k) est vu sur pump.fun avec son X lié.

Une seule alerte par compte X, avec son @ et ses followers. Node.js 22+ suffit, sans aucune dépendance.

## Comment ça marche

pump.fun ne publie aucun événement « compte X lié » : le X n'apparaît que sur le profil de la personne. Le watcher doit donc d'abord trouver les wallets à vérifier, puis lire leur profil. Il combine quatre détections :

| Détection | Quand l'alerte part | Qui est couvert |
| --- | --- | --- |
| **Graphe social de l'app** | Au poll suivant (30 s par défaut) après que la personne a suivi un profil seed | Les nouveaux comptes qui suivent un gros compte ou un profil que tu as choisi |
| **Réclamation de frais X (on-chain)** | À l'instant où la personne connecte son X pour réclamer ses frais | Les comptes X à qui des coins ont réservé des frais (fréquent pour les KOLs) |
| **Activité on-chain** | À son premier achat, vente ou création de coin après le lien | Tous ceux qui tradent ou lancent un coin |
| **Patrouille** | Dans le cycle de patrouille (environ 100 min pour 300 000 wallets à 3 000/min) | Les wallets déjà vus qui lient leur X sans rien faire ensuite |

```
RPC Solana (logsSubscribe)
  programme de frais pump.fun ──► réclamation signée par pump.fun : ID X + wallet ─────────┐
  programmes pump + PumpSwap ───► wallets actifs (créateurs en priorité) ─┐                ├─► @ + followers ─► alerte
PumpPortal (nouveaux coins) ────► créateurs ──────────────────────────────┤                │   (FxTwitter, sinon
Patrouille ─────────────────────► wallets déjà vus sans X ────────────────┴─► pump.fun : ──┘    twitterapi.io / API X)
                                                                              quel X est lié ?
```

1. **Graphe social.** Sur pump.fun, un nouvel inscrit commence presque toujours par suivre des gens. Le watcher relit en boucle la liste des followers de profils « seed » : les 20 plus gros comptes X qu'il a déjà trouvés, plus les wallets que tu ajoutes dans `social.seedWallets`. Chaque nouveau follower est vérifié tout de suite. Les followers déjà présents rejoignent la patrouille.
   Astuce pour la watchlist : mets en seed les profils pump.fun que @naseem va probablement suivre (ses proches, les gros KOLs de son cercle). Le wallet est dans l'URL du profil : `pump.fun/profile/<wallet>`.
2. **Réclamation de frais.** Des coins peuvent réserver leurs frais de créateur à un compte X. Pour les récupérer, la personne se connecte avec son X sur pump.fun, et pump.fun signe une transaction on-chain qui contient son **ID X** et son wallet. Le watcher la voit en direct, retrouve le @ et les followers à partir de l'ID, et alerte aussitôt. Les @ de ta watchlist sont convertis en ID X au démarrage : la correspondance est immédiate, même si la personne change de @.
3. **Activité on-chain.** Le watcher écoute tous les trades et toutes les créations de coins pump.fun (décodés avec l'IDL officiel de pump.fun, à jour au 13/10/2026). Pour chaque wallet actif, il demande à pump.fun quel X est lié, par lots de 50.
4. **Patrouille.** En continu, il revérifie les wallets déjà vus sans X, du plus ancien au plus récent, même s'ils ne font plus rien. Une personne qui lie son X puis reste inactive est repérée au passage suivant, et l'alerte précise « vient de lier son X ».

Dès qu'un X est trouvé, il est comparé à ta watchlist (alerte immédiate) et au seuil de followers. L'alerte contient : le @, les followers, ce qui l'a déclenchée (« réclame ses frais », « a créé $TICKER », « a acheté 2.00 SOL », « repéré par la patrouille »), le wallet, et les liens vers X, le profil pump.fun, le coin et la transaction.

## À savoir avant de l'utiliser

- **Un nouveau compte qui lie son X sans rien faire reste invisible.** S'il ne suit aucun profil seed et ne fait ni trade, ni coin, ni réclamation de frais, son wallet est inconnu et personne en dehors de pump.fun ne peut le vérifier.
- **La liste des followers n'a pas pu être testée en vrai** : son format et le fait qu'elle soit publique viennent du relevé de juin 2026. Vérifie avec `node src/index.js --social <wallet d'un gros profil>`. Si elle renvoie 401, il faut le jeton de ta session pump.fun dans `pump.jwt`.
- **L'API pump.fun utilisée n'est pas officielle** (endpoints relevés dans le trafic du site le 17/06/2026). Elle peut changer sans prévenir. Le watcher teste plusieurs hôtes au démarrage et bascule sur `/users/<wallet>` si `/x/public-handles` ne répond plus. La patrouille ajoute environ une requête par seconde : baisse `patrol.walletsPerMinute` si pump.fun limite.
- **Seuls les X affichés publiquement sur pump.fun sont visibles** pour l'activité et la patrouille. pump.fun permet de masquer le lien. Les réclamations de frais, elles, donnent l'ID X même si le lien est masqué.
- **Au premier lancement**, les comptes déjà liés depuis longtemps déclenchent aussi une alerte la première fois qu'ils sont vus (« première détection »). Ça n'arrive qu'une fois par compte : tout est mémorisé dans `data/state.json`.
- **La patrouille repart de zéro à chaque redémarrage** : elle ne connaît que les wallets vus depuis le lancement (300 000 au maximum).

## Installation

```bash
cd watcher
cp config.example.json config.json   # puis édite config.json
npm start
```

Pour vérifier les notifications sans attendre une vraie détection : `npm run test-notify`.

### Configuration (`config.json`)

| Clé | Rôle |
| --- | --- |
| `watchHandles` | Les @ à surveiller, ex. `["naseem", "@autre"]`. Avec ou sans `@`, majuscules ignorées. |
| `minFollowers` | Seuil d'alerte pour tous les comptes X (`100000` = 100k). `0` désactive. |
| `solana.wsUrl` | WebSocket RPC Solana. **Mets un RPC Helius ou QuickNode** : le RPC public coupe vite. Une clé Helius gratuite suffit pour commencer. |
| `solana.pumpSwap` | Écoute aussi les trades des coins migrés sur PumpSwap (plus de wallets, plus de requêtes). |
| `solana.socialClaims` | Écoute les réclamations de frais par compte X (détection instantanée). Lit ces transactions via l'URL HTTP du RPC : `solana.httpUrl`, ou à défaut `wsUrl` en `https://`. |
| `patrol.walletsPerMinute` | Vitesse de la patrouille (défaut 3000). `0` la désactive. |
| `social.seedWallets` | Wallets de profils pump.fun dont les nouveaux followers sont vérifiés tout de suite. Relu à chaud. |
| `social.autoSeeds` | Nombre de plus gros comptes X déjà trouvés à surveiller aussi (défaut 20). |
| `social.intervalSeconds` | Fréquence de relecture des followers (défaut 30 s, une requête par seed). |
| `pumpPortal.enabled` | Flux de secours PumpPortal pour les nouveaux coins. |
| `pump.recheckMinutes` | Délai minimum avant de revérifier un wallet vu sans X (défaut 5). |
| `pump.jwt` | Seulement si pump.fun se met à exiger une connexion : le jeton de ta session pump.fun. |
| `twitter.xBearerToken` ou `twitter.xApiKey` + `twitter.xApiSecret` | Optionnel. Ton accès à l'API X officielle, utilisé seulement si FxTwitter ne répond pas. Voir « Followers X » plus bas. |
| `twitter.twitterApiIoKey` | Optionnel. Autre secours payant (twitterapi.io). |
| `notify.*` | Canaux d'alerte, voir ci-dessous. Tu peux en activer plusieurs. |

`watchHandles` et `minFollowers` sont relus à chaud : ajoute un @ dans `config.json` et c'est pris en compte en 2 secondes, sans redémarrer. Si ce @ a déjà été vu sur pump.fun, tu reçois l'alerte tout de suite. Les autres réglages demandent un redémarrage.

Les secrets peuvent aussi passer par variables d'environnement : `SOLANA_WS_URL`, `SOLANA_HTTP_URL`, `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID`, `DISCORD_WEBHOOK_URL`, `NTFY_TOPIC`, `X_BEARER_TOKEN`, `X_API_KEY`, `X_API_SECRET`, `TWITTERAPI_IO_KEY`, `PUMP_JWT`, `WATCH_HANDLES` (séparés par des virgules), `MIN_FOLLOWERS`.

### Followers X

Le watcher demande d'abord à FxTwitter, gratuit et sans clé. Si FxTwitter ne répond pas, il passe à twitterapi.io puis à l'API X officielle, si leurs identifiants sont configurés. Chaque compte n'est recherché qu'une fois toutes les 6 h.

Les réclamations de frais ne donnent que l'ID numérique X : le @ et les followers sont alors cherchés par ID (FxTwitter, puis l'API X), avec un repli sur pump.fun pour le wallet.

Depuis février 2026, l'API X est facturée à l'usage, environ 0,01 $ par recherche de profil : c'est pour ça qu'elle sert seulement de secours.

Dans le portail développeur X (Keys and tokens), il te faut **l'un des deux** :

- le **Bearer Token** → `twitter.xBearerToken` ;
- ou l'**API Key** et l'**API Key Secret** (appelées aussi Consumer Keys) → `twitter.xApiKey` et `twitter.xApiSecret`. Le watcher en tire lui-même un Bearer Token, et le régénère s'il est révoqué.

L'Access Token, l'Access Token Secret, le Client ID et le Client Secret ne servent pas ici. Mets ces clés dans `config.json` ou en variables d'environnement, jamais dans un fichier commité : ce repo est public.

### Canaux d'alerte

- **Telegram** : crée un bot avec [@BotFather](https://t.me/BotFather) (`/newbot`) et copie le token. Envoie un message à ton bot, puis ouvre `https://api.telegram.org/bot<TOKEN>/getUpdates` : ton `chatId` est dans `"chat":{"id":…}`.
- **Discord** : Paramètres du salon → Intégrations → Webhooks → Nouveau webhook → copier l'URL.
- **ntfy** (push sur le téléphone, sans compte) : installe l'app ntfy, abonne-toi à un nom de topic long et impossible à deviner, et mets ce nom dans `notify.ntfy.topic`. Les alertes sont envoyées en priorité maximale.

## Commandes utiles

```bash
node src/index.js --check <wallet>      # quel X est lié à ce wallet pump.fun, et ses followers
node src/index.js --social <wallet>     # followers pump.fun d'un profil (teste le graphe social)
node src/index.js --followers @naseem   # followers d'un compte X
node src/index.js --followers @naseem --via x-api   # teste tes identifiants API X
node src/index.js --test-notify         # envoie une fausse alerte sur tous les canaux
npm run find-endpoints                  # liste les routes d'API présentes dans le code public de pump.fun
npm test                                # tests (décodage on-chain, logique d'alerte, clients)
```

Toutes les minutes, le watcher affiche ses stats : activités reçues, wallets vérifiés (dont patrouille), wallets avec X, nouveaux follows, réclamations de frais X, alertes, taille de la file. Si `activités` reste à 0, le RPC Solana ne renvoie rien : change `solana.wsUrl`.

## Le faire tourner 24h/24

Sur un VPS, avec pm2 :

```bash
npm install -g pm2
pm2 start src/index.js --name pumpfun-x-watcher
pm2 save && pm2 startup
```

Ou avec systemd : un service `ExecStart=/usr/bin/node /chemin/vers/watcher/src/index.js` avec `Restart=always`.
