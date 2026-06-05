const axios = require("axios");
const { Connection, PublicKey, Keypair, Transaction } = require("@solana/web3.js");
const { getOrCreateAssociatedTokenAccount, createTransferInstruction } = require("@solana/spl-token");
const bs58 = require("bs58");

// Liste de secours des RPCs publics
const RPC_LIST = [
    "https://ssc-dao.genesysgo.net",
    "https://api.mainnet-beta.solana.com",
    "https://rpc.ankr.com/solana"
];

const USDT_MINT = new PublicKey("DrnoyNZVRzYZwRbDPmN9hhJzGgD3AXtyZYPqdBzrstFQ");
const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

async function getSolPrice() {
    try {
        const res = await axios.get("https://api.binance.com/api/v3/ticker/price?symbol=SOLUSDT", { timeout: 3000 });
        return parseFloat(res.data.price);
    } catch (e) { return 170; }
}

async function sendUSDT(toAddress, amountUSDT) {
    // On essaie d'envoyer en testant les RPC un par un
    for (let rpc of RPC_LIST) {
        try {
            const connection = new Connection(rpc, "confirmed");
            let secretKey;
            const rawKey = (process.env.SOLFLARE_PRIVATE_KEY || "").trim();
            if (!rawKey) throw new Error("PK manquante");

            secretKey = rawKey.includes("[") ? Uint8Array.from(JSON.parse(rawKey)) : bs58.decode(rawKey);
            if (secretKey.length > 64) secretKey = secretKey.slice(0, 64);

            const fromWallet = Keypair.fromSecretKey(secretKey);
            const fromAcc = await getOrCreateAssociatedTokenAccount(connection, fromWallet, USDT_MINT, fromWallet.publicKey);
            const toAcc = await getOrCreateAssociatedTokenAccount(connection, fromWallet, USDT_MINT, new PublicKey(toAddress));

            const tx = new Transaction().add(
                createTransferInstruction(fromAcc.address, toAcc.address, fromWallet.publicKey, Math.floor(amountUSDT * 1000000))
            );

            const sig = await connection.sendTransaction(tx, [fromWallet]);
            await connection.confirmTransaction(sig, "confirmed");
            return { success: true, signature: sig };
        } catch (e) {
            console.error(`[RPC-ENVOI-FAIL] ${rpc.split('/')[2]} : ${e.message}`);
            continue; // On passe au RPC suivant
        }
    }
    return { success: false, error: "Tous les RPC ont échoué" };
}

async function checkPendingPayments(sessions, callback) {
    for (const id in sessions) {
        for (const m in sessions[id].methods) {
            const p = sessions[id].methods[m];
            if (p.paid || p.expires_at < Date.now()) continue;

            const [usd] = p.pack.split('|').map(Number);
            if (m === "SOL" || m === "CARD") {
                // On tente la détection sur les différents RPC
                for (let rpc of RPC_LIST) {
                    try {
                        const conn = new Connection(rpc, "confirmed");
                        const sigs = await conn.getSignaturesForAddress(new PublicKey(p.address), { limit: 3 });
                        
                        for (const sigInfo of sigs) {
                            if ((sigInfo.blockTime * 1000) > sessions[id].created_at) {
                                await sleep(300);
                                const tx = await conn.getTransaction(sigInfo.signature, { maxSupportedTransactionVersion: 0 });
                                if (tx && tx.meta) {
                                    const idx = tx.transaction.message.staticAccountKeys.findIndex(k => k.toBase58() === p.address);
                                    if (idx !== -1) {
                                        const diff = tx.meta.postBalances[idx] - tx.meta.preBalances[idx];
                                        if (diff > 0) {
                                            const solPrice = await getSolPrice();
                                            const valUSD = (diff / 1e9) * solPrice;
                                            if (valUSD >= (usd * 0.90)) {
                                                console.log(`[OK] Detection via ${rpc.split('/')[2]} : ${valUSD.toFixed(2)}$`);
                                                p.paid = true;
                                                const res = await sendUSDT(p.wallet, p.total_tokens);
                                                if (res.success) {
                                                    p.usdt_sent = true;
                                                    p.usdt_tx_signature = res.signature;
                                                    if (callback) await callback(id, m, usd, p.wallet, sigInfo.signature, res.signature);
                                                }
                                                break;
                                            }
                                        }
                                    }
                                }
                            }
                        }
                        break; // Si on arrive ici sans erreur, on a fini pour cette méthode
                    } catch (e) {
                        console.warn(`[RPC-CHECK-FAIL] ${rpc.split('/')[2]} : ${e.message}`);
                        // On continue la boucle vers le RPC suivant
                    }
                }
            }
        }
    }
}

module.exports = { checkPendingPayments };