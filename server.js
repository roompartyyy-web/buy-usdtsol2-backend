require("dotenv").config();

const express = require("express");
const cors = require("cors");
const { v4: uuidv4 } = require("uuid");

const app = express();

app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 3000;

// Adresses de test
const wallets = {
  BTC: "bc1qtestxxxxxxxxxxxxxxxxxxxxxxxxxxxx",
  ETH: "0x1234567890123456789012345678901234567890",
  SOL: "8ioZBXYBecxiYhNpSDfaxFUK91w5TsUhZBaFkfJ4Bj1C",
  "USDT ERC20": "0x1234567890123456789012345678901234567890",
  "USDT TRC20": "TTestxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"
};

app.get("/", (req, res) => {
  res.json({
    success: true,
    message: "Buy-USDT backend online"
  });
});

app.post("/api/payment/init", (req, res) => {
  const { pack, wallet, payment_method } = req.body;

  if (!pack || !wallet || !payment_method) {
    return res.status(400).json({
      success: false,
      msg: "missing fields"
    });
  }

  const address = wallets[payment_method];

  if (!address) {
    return res.status(400).json({
      success: false,
      msg: "invalid payment method"
    });
  }

  res.json({
    success: true,
    session_id: uuidv4(),
    unique_payment_address: address,
    payment_method,
    pack
  });
});

app.listen(PORT, () => {
  console.log(`Backend running on port ${PORT}`);
});