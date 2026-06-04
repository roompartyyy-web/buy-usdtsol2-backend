const axios = require("axios");
require("dotenv").config();

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const ADMIN_ID = process.env.TELEGRAM_ADMIN_ID;

function getExplorerLink(method, txHash) {
    if (!txHash) return "";
    switch (method) {
        case "BTC":
            return `https://blockstream.info/tx/${txHash}`;
        case "ETH":
            return `https://etherscan.io/tx/${txHash}`;
        case "USDT ERC20":
            return `https://etherscan.io/tx/${txHash}`;
        case "USDT TRC20":
            return `https://tronscan.org/#/transaction/${txHash}`;
        case "SOL":
        case "CARD":
            return `https://solscan.io/tx/${txHash}`;
        default:
            return `https://solscan.io/tx/${txHash}`;
    }
}

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

async function notifyParrain(parrainTelegramId, parrainName, amount, method, paymentTx, deliveryTx) {
    const paymentLink = paymentTx ? `\n<b> Paiement client :</b> ${getExplorerLink(method, paymentTx)}` : "";
    const deliveryLink = deliveryTx ? `\n<b> Livraison USDT :</b> ${getExplorerLink("SOL", deliveryTx)}` : "";

    const msg = ` <b>Bien joué ${parrainName} !</b>\n\nUn de tes clients vient d'acheter pour un montant de <b>${amount}$</b>.\nMéthode de paiement : <b>${method}</b>.${paymentLink}${deliveryLink}\n\nMerci pour ton parrainage !`;

    await sendTelegramMessage(parrainTelegramId, msg);
}

async function notifyAdmin(parrainName, code, amount, method, clientWallet, paymentTx, deliveryTx) {
    const paymentLink = paymentTx ? `\n<b> Paiement client :</b> ${getExplorerLink(method, paymentTx)}` : "";
    const deliveryLink = deliveryTx ? `\n<b> Livraison USDT (Solana) :</b> ${getExplorerLink("SOL", deliveryTx)}` : "";

    const msg = ` <b>VENTE FAITE</b>\n\n` +
                ` <b>Parrain :</b> ${parrainName}\n` +
                ` <b>Code utilisé :</b> ${code}\n` +
                ` <b>Montant :</b> ${amount}$\n` +
                ` <b>Méthode :</b> ${method}\n` +
                ` <b>Wallet Client :</b> <code>${clientWallet}</code>` +
                paymentLink +
                deliveryLink;

    await sendTelegramMessage(ADMIN_ID, msg);
}

module.exports = { notifyParrain, notifyAdmin, sendTelegramMessage };