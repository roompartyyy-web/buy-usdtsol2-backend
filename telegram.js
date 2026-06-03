const axios = require("axios");
require("dotenv").config();

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const ADMIN_ID = process.env.TELEGRAM_ADMIN_ID;

async function sendTelegramMessage(chatId, message) {
    try {
        await axios.post(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
            chat_id: chatId,
            text: message,
            parse_mode: "HTML"
        });
        console.log("Message Telegram envoyé à", chatId);
    } catch (e) {
        console.error("Telegram error:", e.message);
    }
}

async function notifyParrain(parrainTelegramId, parrainName, amount, method) {
    const msg = `🎉 <b>Nouvelle vente !</b>\n\nVotre filleul a acheté <b>${amount}$</b> de USDT\nPaiement par : <b>${method}</b>\n\nMerci pour votre parrainage !`;
    await sendTelegramMessage(parrainTelegramId, msg);
}

async function notifyAdmin(parrainName, code, amount, method, clientWallet) {
    const msg = `💰 <b>Vente réalisée</b>\n\nParrain : <b>${parrainName}</b> (code: ${code})\nMontant : <b>${amount}$</b>\nMéthode : <b>${method}</b>\nClient wallet : <code>${clientWallet}</code>`;
    await sendTelegramMessage(ADMIN_ID, msg);
}

module.exports = { notifyParrain, notifyAdmin };