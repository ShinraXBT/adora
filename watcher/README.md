# pump.fun X watcher

Alerte instantanée (Telegram, Discord ou notification push ntfy) quand :

- **un @ de ta watchlist** (ex. `@naseem`) est vu sur pump.fun avec son compte X lié ;
- **n'importe quel compte X au-dessus d'un seuil de followers** (ex. 100k) est vu sur pump.fun avec son X lié.

Une seule alerte par compte X. Node.js 22+ suffit, sans aucune dépendance.

## Comment ça marche

```
RPC Solana (logsSubscribe)          ┐
  programme pump + PumpSwap         ├─► wallets actifs ─► pump.fun : quel X est lié ? ─► followers X ─► alerte
  chaque trade et chaque création   │   (créateurs      (/x/public-handles par lots,   (FxTwitter,
PumpPortal (nouveaux coins)         ┘    en priorité)    sinon /users/<wallet>)         twitterapi.io ou API X)
```

1. Le watcher écoute en direct tous les trades et toutes les créations de coins pump.fun sur la blockchain (décodés avec l'IDL officiel de pump.fun, à jour au 13/10/2026).
2. Pour chaque wallet actif (acheteur, vendeur, créateur), il demande à pump.fun quel compte X est lié au profil, par lots de 50 wallets.
3. Si le X est dans ta watchlist, l'alerte part tout de suite. Sinon il récupère le nombre de followers et alerte si c'est au-dessus du seuil.
4. Un wallet vu sans X est revérifié à sa prochaine activité (au plus toutes les 5 min). Si son X apparaît entre-temps, l'alerte précise « vient de lier son X ».

L'alerte contient : le @, les followers, l'action (« a créé $TICKER », « a acheté 2.00 SOL »…), le wallet, et les liens vers X, le profil pump.fun, le coin et la transaction.

## À savoir avant de l'utiliser

- **pump.fun ne publie aucun événement « compte X lié ».** Le watcher repère la personne à sa première action on-chain sur pump.fun après avoir lié son X (achat, vente ou création de coin), en général quelques secondes après. Quelqu'un qui lie son X sans jamais trader ni créer de coin n'est pas repéré.
- **L'API pump.fun utilisée n'est pas officielle** (endpoints relevés dans le trafic du site le 17/06/2026). Elle peut changer sans prévenir. Le watcher teste plusieurs hôtes au démarrage et bascule sur `/users/<wallet>` si `/x/public-handles` ne répond plus.
- **Seuls les X affichés publiquement sur pump.fun sont visibles.** pump.fun permet de masquer le lien et semble exiger un minimum de followers pour l'afficher.
- **Au premier lancement**, les comptes déjà liés depuis longtemps déclenchent aussi une alerte la première fois qu'ils tradent (« première détection »). Ça n'arrive qu'une fois par compte : tout est mémorisé dans `data/state.json`.

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
| `pumpPortal.enabled` | Flux de secours PumpPortal pour les nouveaux coins. |
| `pump.recheckMinutes` | Délai minimum avant de revérifier un wallet vu sans X (défaut 5). |
| `pump.jwt` | Seulement si pump.fun se met à exiger une connexion : le jeton de ta session pump.fun. |
| `twitter.xBearerToken` ou `twitter.xApiKey` + `twitter.xApiSecret` | Optionnel. Ton accès à l'API X officielle, utilisé seulement si FxTwitter ne répond pas. Voir « Followers X » plus bas. |
| `twitter.twitterApiIoKey` | Optionnel. Autre secours payant (twitterapi.io). |
| `notify.*` | Canaux d'alerte, voir ci-dessous. Tu peux en activer plusieurs. |

`watchHandles` et `minFollowers` sont relus à chaud : ajoute un @ dans `config.json` et c'est pris en compte en 2 secondes, sans redémarrer. Si ce @ a déjà été vu sur pump.fun, tu reçois l'alerte tout de suite. Les autres réglages demandent un redémarrage.

Les secrets peuvent aussi passer par variables d'environnement : `SOLANA_WS_URL`, `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID`, `DISCORD_WEBHOOK_URL`, `NTFY_TOPIC`, `X_BEARER_TOKEN`, `X_API_KEY`, `X_API_SECRET`, `TWITTERAPI_IO_KEY`, `PUMP_JWT`, `WATCH_HANDLES` (séparés par des virgules), `MIN_FOLLOWERS`.

### Followers X

Le watcher demande d'abord à FxTwitter, gratuit et sans clé. Si FxTwitter ne répond pas, il passe à twitterapi.io puis à l'API X officielle, si leurs identifiants sont configurés. Chaque compte n'est recherché qu'une fois toutes les 6 h.

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
node src/index.js --followers @naseem   # followers d'un compte X
node src/index.js --followers @naseem --via x-api   # teste tes identifiants API X
node src/index.js --test-notify         # envoie une fausse alerte sur tous les canaux
npm test                                # tests (décodage on-chain, logique d'alerte, clients)
```

Toutes les minutes, le watcher affiche ses stats : activités on-chain reçues, wallets vérifiés, wallets avec X, alertes, taille de la file. Si `activités` reste à 0, le RPC Solana ne renvoie rien : change `solana.wsUrl`.

## Le faire tourner 24h/24

Sur un VPS, avec pm2 :

```bash
npm install -g pm2
pm2 start src/index.js --name pumpfun-x-watcher
pm2 save && pm2 startup
```

Ou avec systemd : un service `ExecStart=/usr/bin/node /chemin/vers/watcher/src/index.js` avec `Restart=always`.
