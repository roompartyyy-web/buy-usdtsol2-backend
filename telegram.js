const axios = require("axios");
require("dotenv").config();

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const ADMIN_ID = process.env.TELEGRAM_ADMIN_ID;

// Fonction de base pour l'envoi
async function sendTelegramMessage(chatId, message) {
    if (!chatId || !message) return;
    try {
        await axios.post(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
            chat_id: chatId,
            text: message,
            parse_mode: "HTML",
            disable_web_page_preview: false
        });
        console.log("Message Telegram envoyé avec succès à :", chatId);
    } catch (e) {
        console.error("Erreur Telegram (chatId: " + chatId + "):", e.message);
    }
}

// Notification pour le PARRAIN
async function notifyParrain(parrainTelegramId, parrainName, amount, method, txSignature) {
    const txLink = txSignature ? `\n\nVoici le lien de la transaction : https://solscan.io/tx/${txSignature}` : "";
    
    const msg = `🎉 <b>Félicitations ${parrainName} !</b>\n\nUn de tes clients vient d'acheter pour un montant de <b>${amount}$</b>.\nPaiement effectué par : <b>${method}</b>.${txLink}\n\nMerci pour ton parrainage !`;
    
    await sendTelegramMessage(parrainTelegramId, msg);
}

// Notification pour l'ADMIN (Toi)
async function notifyAdmin(parrainName, code, amount, method, clientWallet, txSignature) {
    const txLink = txSignature ? `\n\n<b>Transaction :</b> https://solscan.io/tx/${txSignature}` : "";
    
    const msg = `💰 <b>VENTE RÉALISÉE</b>\n\n` +
                `👤 <b>Parrain :</b> ${parrainName}\n` +
                `🎫 <b>Code utilisé :</b> ${code}\n` +
                `💵 <b>Montant :</b> ${amount}$\n` +
                `💳 <b>Méthode :</b> ${method}\n` +
                `👛 <b>Wallet Client :</b> <code>${clientWallet}</code>` +
                txLink;
                
    await sendTelegramMessage(ADMIN_ID, msg);
}

module.exports = { notifyParrain, notifyAdmin, sendTelegramMessage };