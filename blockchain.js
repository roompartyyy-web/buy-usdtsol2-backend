const axios = require("axios");
const { Connection, PublicKey, LAMPORTS_PER_SOL, Keypair, Transaction } = require("@solana/web3.js");
const { getOrCreateAssociatedTokenAccount, createTransferInstruction } = require("@solana/spl-token");
const bs58 = require("bs58");
const { sendTelegramMessage } = require("./telegram");

// CONFIGURATION STABLE
const SOLANA_RPC = "https://api.mainnet-beta.solana.com";
const BTC_API = "https://blockstream.info/api"; 
const USDT_MINT = new PublicKey("DrnoyNZVRzYZwRbDPmN9hhJzGgD3AXtyZYPqdBzrstFQ");

// ═══════════════════════════════════════════════════════════
//  ENVOI AUTO DES TOKENS (SOLANA)
// ═══════════════════════════════════════════════════════════
async function sendUSDT(toAddress, amountUSDT) {
    try {
        const connection = new Connection(SOLANA_RPC, "confirmed");
        const privKey = process.env.SOLFLARE_PRIVATE_KEY;
        if (!privKey) return { success: false, error: "Clé privée manquante sur Render" };
        
        const fromWallet = Keypair.fromSecretKey(bs58.decode(privKey));
        const toPubkey = new PublicKey(toAddress);
        
        // 1. Préparation des comptes de tokens
        const fromAcc = await getOrCreateAssociatedTokenAccount(connection, fromWallet, USDT_MINT, fromWallet.publicKey);
        const toAcc = await getOrCreateAssociatedTokenAccount(connection, fromWallet, USDT_MINT, toPubkey);
        
        // 2. Vérification solde réel avant envoi (évite de payer des frais SOL pour rien)
        const balance = await connection.getTokenAccountBalance(fromAcc.address);
        if (balance.value.uiAmount < amountUSDT) {
            return { success: false, error: `Solde insuffisant dans le wallet d'envoi (${balance.value.uiAmount} USDT)` };
        }

        // 3. Création et envoi de la transaction
        const tx = new Transaction().add(
            createTransferInstruction(fromAcc.address, toAcc.address, fromWallet.publicKey, Math.floor(amountUSDT * 1_000_000))
        );
        
        const sig = await connection.sendTransaction(tx, [fromWallet], { skipPreflight: false, preflightCommitment: "confirmed" });
        await connection.confirmTransaction(sig, "confirmed");
        
        console.log(`✅ Livraison réussie: ${amountUSDT} USDT envoyés à ${toAddress}`);
        return { success: true, signature: sig };
    } catch (e) {
        console.error("❌ Erreur critique envoi Solana:", e.message);
        return { success: false, error: e.message };
    }
}

// ═══════════════════════════════════════════════════════════
//  VÉRIFICATION ETH / USDT ERC20
// ═══════════════════════════════════════════════════════════
async function checkETHPayment(address, expectedUSD, isUSDT = false) {
    try {
        const apiKey = process.env.ETHERSCAN_API_KEY || "V7BTMUQGKXVH1HNPI3WNIGE1HJBBXM4S3K";
        const url = isUSDT 
            ? `https://api.etherscan.io/api?module=account&action=tokentx&contractaddress=0xdAC17F958D2ee523a2206206994597C13D831ec7&address=${address}&sort=desc&apikey=${apiKey}`
            : `https://api.etherscan.io/api?module=account&action=txlist&address=${address}&sort=desc&apikey=${apiKey}`;
        
        const res = await axios.get(url);
        if (!res.data || !res.data.result || !Array.isArray(res.data.result)) return { received: false };

        for (const tx of res.data.result) {
            // Sécurité : Vérifie que la transaction possède un destinataire et qu'il correspond à l'adresse surveillée
            if (tx.to && tx.to.toLowerCase() === address.toLowerCase()) {
                const val = isUSDT ? (Number(tx.value) / 1e6) : (Number(tx.value) / 1e18);
                let finalUSD = val;
                
                if (!isUSDT) {
                    const price = await axios.get("https://api.coingecko.com/api/v3/simple/price?ids=ethereum&vs_currencies=usd");
                    finalUSD = val * price.data.ethereum.usd;
                }

                // Marge de 10% pour couvrir les frais de plateforme client
                if (finalUSD >= expectedUSD * 0.90) return { received: true, txSignature: tx.hash };
            }
        }
    } catch (e) { console.error("Erreur scan ETH:", e.message); }
    return { received: false };
}

// ═══════════════════════════════════════════════════════════
//  VÉRIFICATION BTC (VIA BLOCKSTREAM)
// ═══════════════════════════════════════════════════════════
async function checkBTCPayment(address, expectedUSD) {
    try {
        const res = await axios.get(`${BTC_API}/address/${address}/utxo`);
        if (!res.data || res.data.length === 0) return { received: false };

        const price = await axios.get("https://api.coingecko.com/api/v3/simple/price?ids=bitcoin&vs_currencies=usd");
        const btcPrice = price.data.bitcoin.usd;

        for (const utxo of res.data) {
            const usdVal = (utxo.value / 1e8) * btcPrice;
            if (usdVal >= expectedUSD * 0.90) return { received: true, txSignature: utxo.txid };
        }
    } catch (e) { console.error("Erreur scan BTC:", e.message); }
    return { received: false };
}

// ═══════════════════════════════════════════════════════════
//  SURVEILLANCE GLOBALE
// ═══════════════════════════════════════════════════════════
async function checkPendingPayments(sessions) {
    for (const sessionId in sessions) {
        const session = sessions[sessionId];
        for (const method in session.methods) {
            const pay = session.methods[method];
            if (pay.paid || (pay.expires_at && pay.expires_at < Date.now())) continue;

            const [usdAmount, baseTokens] = pay.pack.split('|').map(Number);
            const totalToDeliver = baseTokens + Math.floor(baseTokens * (pay.discount_percent || 0) / 100);

            let check = { received: false };
            
            if (method === "BTC") check = await checkBTCPayment(pay.address, usdAmount);
            else if (method === "USDT ERC20") check = await checkETHPayment(pay.address, usdAmount, true);
            else if (method === "ETH") check = await checkETHPayment(pay.address, usdAmount, false);
            else if (method === "USDT TRC20") {
                try {
                    const res = await axios.get(`https://api.trongrid.io/v1/accounts/${pay.address}/transactions/trc20?limit=5`);
                    if (res.data.data) {
                        for (const tx of res.data.data) {
                            if (tx.token_info.symbol === "USDT" && (Number(tx.value) / 1e6) >= usdAmount * 0.90) {
                                check = { received: true, txSignature: tx.transaction_id };
                            }
                        }
                    }
                } catch(e) {}
            }
            else if (method === "SOL" || method === "CARD") {
                try {
                    const conn = new Connection(SOLANA_RPC);
                    const sigs = await conn.getSignaturesForAddress(new PublicKey(pay.address), { limit: 3 });
                    if (sigs.length > 0) check = { received: true, txSignature: sigs[0].signature };
                } catch(e) {}
            }

            if (check.received) {
                console.log(`💰 PAIEMENT DÉTECTÉ [${method}] - Session: ${sessionId}`);
                pay.paid = true;
                pay.tx_signature = check.txSignature;
                
                const delivery = await sendUSDT(pay.wallet, totalToDeliver);
                if (delivery.success) {
                    pay.usdt_sent = true;
                    pay.usdt_tx_signature = delivery.signature;
                }

                // NOTIF ADMIN
                const adminId = process.env.TELEGRAM_ADMIN_ID || "8038281668";
                const msg = `💰 <b>PAIEMENT REÇU (${method})</b>\n\n` +
                            `Montant: ${usdAmount}$\n` +
                            `Livraison: ${totalToDeliver} FAKE USDT\n` +
                            `Status: ${delivery.success ? "✅ RÉUSSI" : "❌ ÉCHOUÉ ("+delivery.error+")"}\n` +
                            `Wallet Client: <code>${pay.wallet}</code>`;
                
                await sendTelegramMessage(adminId, msg);
            }
        }
    }
}

module.exports = { checkPendingPayments, sendUSDT };