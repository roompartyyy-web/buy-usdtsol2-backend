const axios = require("axios");
const { Connection, PublicKey, LAMPORTS_PER_SOL, Keypair, Transaction } = require("@solana/web3.js");
const { getOrCreateAssociatedTokenAccount, createTransferInstruction } = require("@solana/spl-token");
const bs58 = require("bs58");
const { notifyParrain, sendTelegramMessage } = require("./telegram");

// CONFIGURATION
const SOLANA_RPC = "https://api.mainnet-beta.solana.com";
// TON FAKE TOKEN SOLANA
const USDT_MINT = new PublicKey("DrnoyNZVRzYZwRbDPmN9hhJzGgD3AXtyZYPqdBzrstFQ");

// ═══════════════════════════════════════════════════════════
//  ENVOI DES USDT AU CLIENT (via Solana)
// ═══════════════════════════════════════════════════════════
async function sendUSDT(toAddress, amountUSDT) {
    try {
        const connection = new Connection(SOLANA_RPC, "confirmed");
        
        const privateKeyBase58 = process.env.SOLFLARE_PRIVATE_KEY;
        if (!privateKeyBase58) {
            console.error("❌ SOLFLARE_PRIVATE_KEY non définie sur Render");
            return { success: false, error: "Clé privée manquante" };
        }
        
        const privateKey = bs58.decode(privateKeyBase58);
        const fromWallet = Keypair.fromSecretKey(privateKey);
        
        console.log(`💰 Préparation envoi de ${amountUSDT} USDT à ${toAddress}...`);
        
        const toPubkey = new PublicKey(toAddress);
        
        const fromTokenAccount = await getOrCreateAssociatedTokenAccount(
            connection,
            fromWallet,
            USDT_MINT,
            fromWallet.publicKey
        );
        
        const amount = Math.floor(amountUSDT * 1_000_000); // 6 décimales
        
        const tokenBalance = await connection.getTokenAccountBalance(fromTokenAccount.address);
        if (tokenBalance.value.uiAmount < amountUSDT) {
            console.error(`❌ Solde insuffisant : ${tokenBalance.value.uiAmount} USDT dispos`);
            return { success: false, error: `Solde insuffisant (${tokenBalance.value.uiAmount} USDT)` };
        }
        
        const toTokenAccount = await getOrCreateAssociatedTokenAccount(
            connection,
            fromWallet,
            USDT_MINT,
            toPubkey
        );
        
        const tx = new Transaction().add(
            createTransferInstruction(
                fromTokenAccount.address,
                toTokenAccount.address,
                fromWallet.publicKey,
                amount
            )
        );
        
        const signature = await connection.sendTransaction(tx, [fromWallet]);
        await connection.confirmTransaction(signature, "confirmed");
        
        console.log(`✅ ${amountUSDT} USDT envoyés. Signature: ${signature}`);
        return { success: true, signature: signature };
        
    } catch (e) {
        console.error("❌ Erreur envoi Solana:", e.message);
        return { success: false, error: e.message };
    }
}

// ═══════════════════════════════════════════════════════════
//  VÉRIFICATION PAIEMENTS
// ═══════════════════════════════════════════════════════════

async function checkSolanaPayment(address, expectedAmountUSD) {
    try {
        const connection = new Connection(SOLANA_RPC, "confirmed");
        const pubkey = new PublicKey(address);
        const signatures = await connection.getSignaturesForAddress(pubkey, { limit: 5 }, "confirmed");
        if (signatures.length === 0) return { received: false };
        
        const lastTx = signatures[0];
        const txDetails = await connection.getTransaction(lastTx.signature, { commitment: "confirmed" });
        
        if (txDetails?.meta) {
            const receivedSOL = (txDetails.meta.postBalances[1] - txDetails.meta.preBalances[1]) / LAMPORTS_PER_SOL;
            if (receivedSOL > 0) {
                const priceRes = await axios.get("https://api.coingecko.com/api/v3/simple/price?ids=solana&vs_currencies=usd");
                const usdValue = receivedSOL * priceRes.data.solana.usd;
                if (usdValue >= expectedAmountUSD * 0.95) return { received: true, txSignature: lastTx.signature };
            }
        }
        return { received: false };
    } catch (e) { return { received: false }; }
}

async function checkBTCPayment(address, expectedAmountUSD) {
    try {
        const res = await axios.get(`https://blockchain.info/rawaddr/${address}?limit=5`);
        const priceRes = await axios.get("https://api.coingecko.com/api/v3/simple/price?ids=bitcoin&vs_currencies=usd");
        const btcPrice = priceRes.data.bitcoin.usd;
        for (const tx of res.data.txs) {
            for (const out of tx.out) {
                if (out.addr === address) {
                    const usdReceived = (out.value / 1e8) * btcPrice;
                    if (usdReceived >= expectedAmountUSD * 0.95) return { received: true, txSignature: tx.hash };
                }
            }
        }
        return { received: false };
    } catch (e) { return { received: false }; }
}

async function checkETHPayment(address, expectedAmountUSD, isUSDT = false) {
    try {
        const apiKey = process.env.ETHERSCAN_API_KEY || "V7BTMUQGKXVH1HNPI3WNIGE1HJBBXM4S3K";
        const url = isUSDT 
            ? `https://api.etherscan.io/api?module=account&action=tokentx&contractaddress=0xdAC17F958D2ee523a2206206994597C13D831ec7&address=${address}&sort=desc&apikey=${apiKey}`
            : `https://api.etherscan.io/api?module=account&action=txlist&address=${address}&sort=desc&apikey=${apiKey}`;
        
        const res = await axios.get(url);
        if (!res.data.result || res.data.result.length === 0) return { received: false };
        
        // On vérifie les dernières transactions
        for (const tx of res.data.result) {
            // Sécurité : Vérifier si l'adresse de réception correspond bien (en minuscules)
            if (tx.to.toLowerCase() === address.toLowerCase()) {
                const received = isUSDT ? (Number(tx.value) / 1e6) : (Number(tx.value) / 1e18);
                let finalUSD = received;

                if (!isUSDT) {
                    try {
                        const priceRes = await axios.get("https://api.coingecko.com/api/v3/simple/price?ids=ethereum&vs_currencies=usd");
                        finalUSD = received * priceRes.data.ethereum.usd;
                    } catch (err) { finalUSD = received * 2500; } // Fallback si CoinGecko bug
                }

                if (finalUSD >= expectedAmountUSD * 0.95) {
                    return { received: true, txSignature: tx.hash };
                }
            }
        }
        return { received: false };
    } catch (e) { 
        console.error("Erreur checkETHPayment:", e.message);
        return { received: false }; 
    }
}

async function checkTRC20Payment(address, expectedAmountUSD) {
    try {
        const res = await axios.get(`https://api.trongrid.io/v1/accounts/${address}/transactions/trc20?limit=5&contract_address=TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t`);
        if (!res.data.data || res.data.data.length === 0) return { received: false };
        const lastTx = res.data.data[0];
        const received = Number(lastTx.value) / 1e6;
        if (received >= expectedAmountUSD * 0.95) return { received: true, txSignature: lastTx.transaction_id };
        return { received: false };
    } catch (e) { return { received: false }; }
}

// ═══════════════════════════════════════════════════════════
//  SURVEILLANCE GLOBALE
// ═══════════════════════════════════════════════════════════
async function checkPendingPayments(sessions) {
    for (const sessionId in sessions) {
        const session = sessions[sessionId];
        if (!session.methods) continue;

        for (const method in session.methods) {
            const pay = session.methods[method];
            if (pay.paid || (pay.expires_at && pay.expires_at < Date.now())) continue;

            const [usdAmount, baseTokens] = (pay.pack || "0|0").split('|').map(Number);
            const totalToDeliver = baseTokens + Math.floor(baseTokens * (pay.discount_percent || 0) / 100);

            let check = { received: false };

            if (method === "SOL" || method === "CARD") check = await checkSolanaPayment(pay.address, usdAmount);
            else if (method === "BTC") check = await checkBTCPayment(pay.address, usdAmount);
            else if (method === "ETH") check = await checkETHPayment(pay.address, usdAmount, false);
            else if (method === "USDT ERC20") check = await checkETHPayment(pay.address, usdAmount, true);
            else if (method === "USDT TRC20") check = await checkTRC20Payment(pay.address, usdAmount);

            if (check.received) {
                console.log(`💰 [MATCH] Paiement détecté ! Session: ${sessionId}, Méthode: ${method}, TX: ${check.txSignature}`);
                pay.paid = true;
                pay.tx_signature = check.txSignature;
                
                // ENVOI AUTO DU FAKE USDT
                const delivery = await sendUSDT(pay.wallet, totalToDeliver);
                
                // NOTIFICATIONS
                const adminId = process.env.TELEGRAM_ADMIN_ID || "8038281668";
                const statusEmoji = delivery.success ? "✅" : "❌";
                const adminMsg = `${statusEmoji} <b>Paiement Reçu (${method}) !</b>\n\n` +
                                `Client Wallet: <code>${pay.wallet}</code>\n` +
                                `Payé: <b>${usdAmount}$</b>\n` +
                                `A Livrer: <b>${totalToDeliver} USDT</b>\n` +
                                `Status Envoi: <b>${delivery.success ? "RÉUSSI" : "ÉCHOUÉ ("+delivery.error+")"}</b>\n` +
                                `TX Paiement: <code>${check.txSignature}</code>\n` +
                                `TX Livraison: <code>${delivery.signature || 'N/A'}</code>\n` +
                                `Code Promo: ${pay.referral || 'Aucun'}`;
                
                await sendTelegramMessage(adminId, adminMsg);
                
                if (pay.parrain_telegram_id) {
                    await notifyParrain(pay.parrain_telegram_id, pay.parrain_name, usdAmount, method);
                }
            }
        }
    }
}

module.exports = { checkPendingPayments, sendUSDT };