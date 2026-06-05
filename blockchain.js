const axios = require("axios");
const { Connection, PublicKey, Keypair, Transaction } = require("@solana/web3.js");
const { getOrCreateAssociatedTokenAccount, createTransferInstruction } = require("@solana/spl-token");
const bs58 = require("bs58");

// ON UTILISE EXACTEMENT LES NOMS DE TES VARIABLES RENDER
// Fallback sur Helius si la variable Render a un souci
const FALLBACK_RPC = "https://mainnet.helius-rpc.com/?api-key=764be8a6-6eb9-4994-9dee-da135e6b48c3";
const SOLANA_RPC = process.env.SOLANA_RPC || FALLBACK_RPC;
const USDT_MINT = new PublicKey("DrnoyNZVRzYZwRbDPmN9hhJzGgD3AXtyZYPqdBzrstFQ");

async function sendUSDT(toAddress, amountUSDT) {
    try {
        const connection = new Connection(SOLANA_RPC, "confirmed");
        let secretKey;
        
        // Utilisation du nom EXACT : SOLFLARE_PRIVATE_KEY
        const rawKey = (process.env.SOLFLARE_PRIVATE_KEY || "").trim();

        if (!rawKey) throw new Error("La variable SOLFLARE_PRIVATE_KEY est vide dans Render");

        // Décodage de la clé (Base58 ou Array)
        if (rawKey.includes("[")) {
            secretKey = Uint8Array.from(JSON.parse(rawKey));
        } else {
            secretKey = bs58.decode(rawKey);
        }

        // Nettoyage pour les clés Solflare format long (on garde les 64 premiers octets)
        if (secretKey.length > 64) {
            secretKey = secretKey.slice(0, 64);
        }

        const fromWallet = Keypair.fromSecretKey(secretKey);
        const toPubkey = new PublicKey(toAddress);
        
        console.log(`[ENVOI] Tentative d'envoi de ${amountUSDT} USDT vers ${toAddress}`);

        const fromAcc = await getOrCreateAssociatedTokenAccount(connection, fromWallet, USDT_MINT, fromWallet.publicKey);
        const toAcc = await getOrCreateAssociatedTokenAccount(connection, fromWallet, USDT_MINT, toPubkey);
        
        const tx = new Transaction().add(
            createTransferInstruction(
                fromAcc.address, 
                toAcc.address, 
                fromWallet.publicKey, 
                Math.floor(amountUSDT * 1000000)
            )
        );

        const sig = await connection.sendTransaction(tx, [fromWallet]);
        await connection.confirmTransaction(sig, "confirmed");
        return { success: true, signature: sig };

    } catch (e) { 
        console.error("[ERREUR ENVOI]:", e.message);
        return { success: false, error: e.message }; 
    }
}

async function checkPendingPayments(sessions, callback) {
    console.log(`[CHECK] Vérification en cours...`);
    
    for (const id in sessions) {
        for (const m in sessions[id].methods) {
            const p = sessions[id].methods[m];
            if (p.paid || p.expires_at < Date.now()) continue;

            const [usd] = p.pack.split('|').map(Number);
            let check = { received: false, signature: null };

            // === DETECTION SOLANA (SOL/CARD) ===
            if (m === "SOL" || m === "CARD") {
                try {
                    const conn = new Connection(SOLANA_RPC, "confirmed");
                    const sigs = await conn.getSignaturesForAddress(new PublicKey(p.address), { limit: 5 });
                    
                    for (const sigInfo of sigs) {
                        if ((sigInfo.blockTime * 1000) > sessions[id].created_at) {
                            const tx = await conn.getTransaction(sigInfo.signature, { 
                                maxSupportedTransactionVersion: 0, 
                                commitment: "confirmed" 
                            });
                            
                            if (tx && tx.meta) {
                                const balanceIndex = tx.transaction.message.staticAccountKeys.findIndex(k => k.toBase58() === p.address);
                                if (balanceIndex !== -1) {
                                    const diff = tx.meta.postBalances[balanceIndex] - tx.meta.preBalances[balanceIndex];
                                    if (diff > 0) {
                                        const solAmount = diff / 1e9;
                                        const priceRes = await axios.get("https://api.coingecko.com/api/v3/simple/price?ids=solana&vs_currencies=usd");
                                        const usdValue = solAmount * priceRes.data.solana.usd;

                                        if (usdValue >= (usd * 0.90)) {
                                            console.log(`[OK] Paiement de ${usdValue.toFixed(2)}$ détecté !`);
                                            check = { received: true, signature: sigInfo.signature };
                                            break;
                                        }
                                    }
                                }
                            }
                        }
                    }
                } catch(e) { console.error("SOL ERROR:", e.message); }
            }

            // === DETECTION ETHEREUM (ETH/USDT ERC20) ===
            if (m === "ETH" || m === "USDT ERC20") {
                try {
                    const isUSDT = m === "USDT ERC20";
                    const apiKey = "V7BTMUQGKXVH1HNPI3WNIGE1HJBBXM4S3K";
                    const url = isUSDT
                        ? `https://api.etherscan.io/api?module=account&action=tokentx&contractaddress=0xdAC17F958D2ee523a2206206994597C13D831ec7&address=${p.address}&sort=desc&apikey=${apiKey}`
                        : `https://api.etherscan.io/api?module=account&action=txlist&address=${p.address}&sort=desc&apikey=${apiKey}`;
                    
                    const res = await axios.get(url);
                    if (res.data.result && res.data.result.length > 0) {
                        const tx = res.data.result[0];
                        if ((Number(tx.timeStamp) * 1000) > sessions[id].created_at) {
                            let valUSD = 0;
                            if (isUSDT) valUSD = Number(tx.value) / 1e6;
                            else {
                                const ethP = await axios.get("https://api.coingecko.com/api/v3/simple/price?ids=ethereum&vs_currencies=usd");
                                valUSD = (Number(tx.value) / 1e18) * ethP.data.ethereum.usd;
                            }
                            if (valUSD >= (usd * 0.90)) check = { received: true, signature: tx.hash };
                        }
                    }
                } catch(e) { console.error("ETH ERROR:", e.message); }
            }

            // === ACTION FINALE : ENVOI ===
            if (check.received) {
                p.paid = true;
                const result = await sendUSDT(p.wallet, p.total_tokens);
                if (result.success) {
                    p.usdt_sent = true;
                    p.usdt_tx_signature = result.signature;
                    if (callback) await callback(id, m, usd, p.wallet, result.signature);
                }
            }
        }
    }
}

module.exports = { checkPendingPayments };