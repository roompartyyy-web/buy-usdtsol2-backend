const axios = require("axios");
const { Connection, PublicKey, LAMPORTS_PER_SOL } = require("@solana/web3.js");
const { notifyParrain, notifyAdmin } = require("./telegram");

require("dotenv").config();

const SOLANA_RPC = "https://api.mainnet-beta.solana.com";

// ═══════════════════════════════════════════════════════════
//  VÉRIFICATION D'UN PAIEMENT SUR SOLANA
//  Vérifie que le montant exact a été reçu avec 1 confirmation
// ═══════════════════════════════════════════════════════════
async function checkSolanaPayment(address, expectedAmountUSD) {
    try {
        const connection = new Connection(SOLANA_RPC, "confirmed");
        const pubkey = new PublicKey(address);
        
        // Récupère le solde en SOL
        const balance = await connection.getBalance(pubkey, "confirmed");
        const balanceSOL = balance / LAMPORTS_PER_SOL;
        
        // Récupère les signatures récentes
        const signatures = await connection.getSignaturesForAddress(pubkey, { limit: 5 }, "confirmed");
        
        if (signatures.length === 0) {
            return { received: false };
        }
        
        // Vérifie la dernière transaction
        const lastTx = signatures[0];
        
        // Vérifie si la transaction a au moins 1 confirmation
        if (lastTx.confirmationStatus === "confirmed" || lastTx.confirmationStatus === "finalized") {
            const txDetails = await connection.getTransaction(lastTx.signature, { commitment: "confirmed" });
            
            if (txDetails && txDetails.meta) {
                // Montant reçu en lamports
                const preBalance = txDetails.meta.preBalances[1] || 0;
                const postBalance = txDetails.meta.postBalances[1] || 0;
                const receivedLamports = postBalance - preBalance;
                const receivedSOL = receivedLamports / LAMPORTS_PER_SOL;
                
                // Prix du SOL pour comparer
                try {
                    const priceRes = await axios.get("https://api.coingecko.com/api/v3/simple/price?ids=solana&vs_currencies=usd");
                    const solPrice = priceRes.data.solana.usd;
                    const expectedSOL = expectedAmountUSD / solPrice;
                    
                    // Marge d'erreur de 5%
                    const minSOL = expectedSOL * 0.95;
                    const maxSOL = expectedSOL * 1.05;
                    
                    if (receivedSOL >= minSOL && receivedSOL <= maxSOL) {
                        return {
                            received: true,
                            amount: receivedSOL,
                            txSignature: lastTx.signature,
                            confirmations: 1
                        };
                    }
                } catch (e) {
                    console.error("Erreur prix CoinGecko:", e.message);
                }
            }
        }
        
        return { received: false };
        
    } catch (e) {
        console.error("Erreur vérification Solana:", e.message);
        return { received: false, error: e.message };
    }
}

// ═══════════════════════════════════════════════════════════
//  SURVEILLANCE DES PAIEMENTS (appelée toutes les 30s)
// ═══════════════════════════════════════════════════════════
async function checkPendingPayments(sessions) {
    console.log("🔍 Vérification des paiements en attente...");
    
    for (const sessionId in sessions) {
        const session = sessions[sessionId];
        
        if (!session.methods) continue;
        
        for (const method in session.methods) {
            const payment = session.methods[method];
            
            // Ne vérifier que si pas encore payé
            if (payment.paid) continue;
            
            // Ne vérifier que si le timer n'est pas expiré
            if (payment.expires_at && payment.expires_at < Date.now()) continue;
            
            const address = payment.address;
            const pack = payment.pack || "1|2";
            const usdAmount = Number(pack.split('|')[0]);
            
            // On vérifie SOL et CARD (car CARD passe par Solana avec Simplex)
            if (method === "SOL" || method === "CARD") {
                const result = await checkSolanaPayment(address, usdAmount);
                
                if (result.received) {
                    console.log(`💰 Paiement reçu pour session ${sessionId}, méthode ${method}`);
                    
                    // Marquer comme payé
                    payment.paid = true;
                    payment.paid_at = Date.now();
                    payment.tx_signature = result.txSignature;
                    
                    // ═════════════════════════════════════════════════
                    //  ENVOYER LES NOTIFICATIONS TELEGRAM ICI
                    //  (après confirmation du paiement)
                    // ═════════════════════════════════════════════════
                    if (payment.parrain_name && payment.parrain_telegram_id) {
                        notifyParrain(payment.parrain_telegram_id, payment.parrain_name, usdAmount, method);
                        notifyAdmin(payment.parrain_name, payment.referral, usdAmount, method, payment.wallet);
                        console.log(`✅ Notifications Telegram envoyées pour le code: ${payment.referral}`);
                    }
                    
                    console.log(`✅ Paiement confirmé pour session ${sessionId}`);
                }
            }
        }
    }
}

module.exports = { checkPendingPayments };