const axios = require("axios");
const { Connection, PublicKey, LAMPORTS_PER_SOL, Keypair, Transaction } = require("@solana/web3.js");
const { getOrCreateAssociatedTokenAccount, createTransferInstruction } = require("@solana/spl-token");
const bs58 = require("bs58");
const { notifyParrain, notifyAdmin, sendTelegramMessage } = require("./telegram");

// CONFIGURATION
const SOLANA_RPC = "https://api.mainnet-beta.solana.com";
const USDT_MINT = new PublicKey("DrnoyNZVRzYZwRbDPmN9hhJzGgD3AXtyZYPqdBzrstFQ");

// ═══════════════════════════════════════════════════════════
//  ENVOI DES USDT AU CLIENT (via Solana)
// ═══════════════════════════════════════════════════════════
async function sendUSDT(toAddress, amountUSDT) {
    try {
        const connection = new Connection(SOLANA_RPC, "confirmed");
        const privateKeyBase58 = process.env.SOLFLARE_PRIVATE_KEY;
        
        if (!privateKeyBase58) {
            console.error("❌ SOLFLARE_PRIVATE_KEY manquante sur Render");
            return { success: false, error: "Clé privée manquante" };
        }
        
        const fromWallet = Keypair.fromSecretKey(bs58.decode(privateKeyBase58));
        const toPubkey = new PublicKey(toAddress);
        
        const fromTokenAcc = await getOrCreateAssociatedTokenAccount(connection, fromWallet, USDT_MINT, fromWallet.publicKey);
        const amount = Math.floor(amountUSDT * 1_000_000); 

        const tokenBalance = await connection.getTokenAccountBalance(fromTokenAcc.address);
        if (tokenBalance.value.uiAmount < amountUSDT) {
            return { success: false, error: `Solde insuffisant: ${tokenBalance.value.uiAmount}` };
        }
        
        const toTokenAcc = await getOrCreateAssociatedTokenAccount(connection, fromWallet, USDT_MINT, toPubkey);
        
        const tx = new Transaction().add(
            createTransferInstruction(fromTokenAcc.address, toTokenAcc.address, fromWallet.publicKey, amount)
        );
        
        const sig = await connection.sendTransaction(tx, [fromWallet]);
        await connection.confirmTransaction(sig, "confirmed");
        
        console.log(`✅ ${amountUSDT} USDT envoyés. Signature: ${sig}`);
        return { success: true, signature: sig };
    } catch (e) {
        console.error("❌ Erreur envoi Solana:", e.message);
        return { success: false, error: e.message };
    }
}

// ═══════════════════════════════════════════════════════════
//  FONCTION DE DÉTECTION ROBUSTE
// ═══════════════════════════════════════════════════════════

async function checkSolanaPayment(address, expectedUSD) {
    try {
        const connection = new Connection(SOLANA_RPC, "confirmed");
        const signatures = await connection.getSignaturesForAddress(new PublicKey(address), { limit: 5 });
        if (signatures.length === 0) return { received: false };

        const tx = await connection.getTransaction(signatures[0].signature, { commitment: "confirmed" });
        if (tx?.meta) {
            const receivedSOL = (tx.meta.postBalances[1] - tx.meta.preBalances[1]) / LAMPORTS_PER_SOL;
            const priceRes = await axios.get("https://api.coingecko.com/api/v3/simple/price?ids=solana&vs_currencies=usd");
            const usdValue = receivedSOL * priceRes.data.solana.usd;
            if (usdValue >= expectedUSD * 0.95) return { received: true, txSignature: signatures[0].signature };
        }
    } catch (e) {} return { received: false };
}

async function checkBTCPayment(address, expectedUSD) {
    try {
        const res = await axios.get(`https://blockchain.info/rawaddr/${address}?limit=5`);
        const price = await axios.get("https://api.coingecko.com/api/v3/simple/price?ids=bitcoin&vs_currencies=usd");
        for (const tx of res.data.txs) {
            for (const out of tx.out) {
                if (out.addr === address) {
                    if ((out.value / 1e8) * price.data.bitcoin.usd >= expectedUSD * 0.95) return { received: true, txSignature: tx.hash };
                }
            }
        }
    } catch (e) {} return { received: false };
}

async function checkETHPayment(address, expectedAmountUSD, isUSDT = false) {
    try {
        const apiKey = process.env.ETHERSCAN_API_KEY || "V7BTMUQGKXVH1HNPI3WNIGE1HJBBXM4S3K";
        const url = isUSDT 
            ? `https://api.etherscan.io/api?module=account&action=tokentx&contractaddress=0xdAC17F958D2ee523a2206206994597C13D831ec7&address=${address}&sort=desc&apikey=${apiKey}`
            : `https://api.etherscan.io/api?module=account&action=txlist&address=${address}&sort=desc&apikey=${apiKey}`;
        
        const res = await axios.get(url);
        if (!res.data.result || res.data.result.length === 0) return { received: false };

        for (const tx of res.data.result) {
            // FIX CRITIQUE: Forcer la comparaison en minuscules
            if (tx.to && tx.to.toLowerCase() === address.toLowerCase()) {
                const receivedValue = isUSDT ? (Number(tx.value) / 1e6) : (Number(tx.value) / 1e18);
                let finalUSD = receivedValue;

                if (!isUSDT) {
                    const priceRes = await axios.get("https://api.coingecko.com/api/v3/simple/price?ids=ethereum&vs_currencies=usd");
                    finalUSD = receivedValue * priceRes.data.ethereum.usd;
                }

                if (finalUSD >= expectedAmountUSD * 0.92) { // Marge de 8% pour les frais
                    return { received: true, txSignature: tx.hash };
                }
            }
        }
    } catch (e) {} return { received: false };
}

async function checkTRC20Payment(address, expectedUSD) {
    try {
        const res = await axios.get(`https://api.trongrid.io/v1/accounts/${address}/transactions/trc20?limit=5`);
        if (!res.data.data) return { received: false };
        for (const tx of res.data.data) {
            if (tx.token_info.symbol === "USDT" && (Number(tx.value) / 1e6) >= expectedUSD * 0.95) {
                return { received: true, txSignature: tx.transaction_id };
            }
        }
    } catch (e) {} return { received: false };
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

            const packParts = pay.pack.split('|');
            const usdAmount = Number(packParts[0]);
            const baseTokens = Number(packParts[1]);
            const bonus = Math.floor(baseTokens * (pay.discount_percent || 0) / 100);
            const totalToDeliver = baseTokens + bonus;

            let check = { received: false };
            if (method === "SOL" || method === "CARD") check = await checkSolanaPayment(pay.address, usdAmount);
            else if (method === "BTC") check = await checkBTCPayment(pay.address, usdAmount);
            else if (method === "ETH") check = await checkETHPayment(pay.address, usdAmount, false);
            else if (method === "USDT ERC20") check = await checkETHPayment(pay.address, usdAmount, true);
            else if (method === "USDT TRC20") check = await checkTRC20Payment(pay.address, usdAmount);

            if (check.received) {
                console.log(`💰 [MATCH] Paiement détecté pour ${method} !`);
                pay.paid = true;
                pay.tx_signature = check.txSignature;
                
                const delivery = await sendUSDT(pay.wallet, totalToDeliver);
                if (delivery.success) {
                    pay.usdt_sent = true;
                    pay.usdt_tx_signature = delivery.signature;
                }

                // NOTIF ADMIN
                const adminId = process.env.TELEGRAM_ADMIN_ID || "8038281668";
                const adminMsg = `💰 <b>PAIEMENT REÇU (${method})</b>\n\n` +
                                `Wallet Client: <code>${pay.wallet}</code>\n` +
                                `Montant: ${usdAmount}$\n` +
                                `Envoyé: ${totalToDeliver} USDT\n` +
                                `TX Livraison: <code>${delivery.signature || 'N/A'}</code>`;
                
                await sendTelegramMessage(adminId, adminMsg);
            }
        }
    }
}

module.exports = { checkPendingPayments, sendUSDT };