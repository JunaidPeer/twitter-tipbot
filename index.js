const Twit = require("twit");
const config = require("config");
const winston = require("winston");
require("winston-daily-rotate-file");
const Client = require("bitcoin-core");
const avn = new Client({
  username: config.get("avian.username"),
  password: config.get("avian.password"),
  port: config.get("avian.port")
});
const logger = winston.createLogger({
  level: "info",
  format: winston.format.json(),
  transports: [
    new winston.transports.DailyRotateFile({
      filename: "tipbot-%DATE%.log",
      dirname: "./logs",
      datePattern: "YYYY-MM-DD-HH",
      zippedArchive: true,
      maxSize: "20m",
      maxFiles: "14d"
    }),
    new winston.transports.Console({
      format: winston.format.simple(),
      level: "debug"
    })
  ]
});

const T = new Twit({
  consumer_key: config.get("twitter.consumer_key"),
  consumer_secret: config.get("twitter.consumer_secret"),
  access_token: config.get("twitter.access_token"),
  access_token_secret: config.get("twitter.access_token_secret"),
  timeout_ms: 60 * 1000, // optional HTTP request timeout to apply to all requests.
  strictSSL: true // optional - requires SSL certificates to be valid.
});

const stream = T.stream("statuses/filter", { track: config.get("bot.handle") });
logger.info("Avian tipbot started");

stream.on("tweet", function(tweet) {
  if(tweet.user.screen_name === config.get("bot.handle").substring(1)) return;
  let msg = checkTrunc(tweet);
  msg = msg.replace(/[\n\\]/g, " ").slice(msg.lastIndexOf(config.get("bot.handle"))).split(" ");
  if (msg.length >= 2) checkTweet(tweet, msg);
});

function checkTweet(tweet, msg) {
  switch (msg[1]) {
    case "help":
      doHelp(tweet, msg);
      break;
    case "balance":
      doBalance(tweet, msg);
      break;
    case "deposit":
      doDeposit(tweet, msg);
      break;
    case "withdraw":
      doWithdraw(tweet, msg);
      break;
    case "tip":
      doTip(tweet, msg);
      break;
    case "terms":
      doTerms(tweet, msg);
      break;
    case "beyonder":
      logger.info("Got a command with the old format, handling it...");
      checkTweet(tweet, msg.splice(1));
      break;
  }
}

async function doHelp(tweet, msg) {
  try {
    let post = await T.post("statuses/update", {
      status:
      `@${tweet.user.screen_name} `+
      `Call commands with: ${config.get("bot.handle")} + \n` +
      "help - shows this command.\n" +
      "balance - shows your balance.\n" +
      "deposit - displays address for your deposits.\n" +
      "withdraw 'ADDRESS' 'AMOUNT' - Withdraw AMOUNT  to ADDRESS.\n" +
      "tip 'USER' 'AMOUNT' - Tip USER AMOUNT.\n"+
      "terms - displays terms of service.",
      in_reply_to_status_id: tweet.id_str
    });
    logger.info(
      `Sent help to ${tweet.user.screen_name}, tweet id: ${tweet.id_str}`
    );
  } catch (e) {
    logger.error(e);
  }
}
async function doTerms(tweet, msg){
// ADD terms
  await T.post("statuses/update", {
    status:
    `@${tweet.user.screen_name} `+
    "There are no fees to use this bot except the automatic daemon fee. \n"+
    "Under no circumstances the Avian Network or the developer be held responsible for lost, stolen or misdirected funds.",
    in_reply_to_status_id: tweet.id_str
  });
}
async function doBalance(tweet, msg) {
  try {
    const balance = await avn.getBalance(id(tweet.user.id_str), config.get("bot.requiredConfirms")); // Amount of confirms before we can use it.
    const post = await T.post("statuses/update", {
      in_reply_to_status_id: tweet.id_str,
      status: `@${tweet.user.screen_name} You have ${balance} Avian.`
    });
    logger.info(
      `Sent balance command to ${tweet.user.screen_name}, tweet id: ${
        tweet.id_str
      }`
    );
  } catch (e) {
    logger.error(e);
  }
}
async function doDeposit(tweet, msg) {
  try {
    const post = await T.post("statuses/update", {
      status: `@${tweet.user.screen_name} Your personal deposit address is ${await getAddress(id(tweet.user.id_str))}`,
      in_reply_to_status_id: tweet.id_str
    });
    logger.info(
      `Sent personal deposit address to ${tweet.user.screen_name}, tweet id: ${
        tweet.id_str
      }`
    );
  } catch (e) {
    logger.error(e);
  }
}
async function doWithdraw(tweet, msg) {
  try {
  if (msg.length < 4) return doHelp(tweet, msg);
  let address = msg[2];
  let amount = getValidatedAmount(msg[3]);
  if (amount === null) {
    return await T.post("statuses/update", {
      status: `@${tweet.user.screen_name} You are broke or have entered an invalid amount.`,
      in_reply_to_status_id: tweet.id_str
    });
  }
  let txId = await avn.sendFrom(id(tweet.user.id_str), address, amount);
  await T.post("statuses/update", {
    status: `@${tweet.user.screen_name} You withdrew ${amount} Avian to ${address}. \n${txLink(txId)}`,
    in_reply_to_status_id: tweet.id_str
  });
  logger.info(
    `User ${
      tweet.user.screen_name
    } withdraw ${amount} Avian to ${address}, tweet id: ${tweet.id_str}`
  );
  } catch (e) {
    logger.error(e);
  }
}
async function doTip(tweet, msg) {
  try {
    if (msg.length < 3) {
      return doHelp(tweet, msg);
    }
    const amount = getValidatedAmount(msg[3]);
    if (amount === null) {
      return await T.post("statuses/update", {
        status: `@${tweet.user.screen_name} You are broke or have entered an invalid amount.`,
        in_reply_to_status_id: tweet.id_str
      });
    }
    const userToTip = tweet.entities.user_mentions.find(u => `@${u.screen_name}` === msg[2]).id_str;
    let tipToAddress = await getAddress(id(userToTip)) // Call this to ensure user has an account.
    if (userToTip === null) {
      return await T.post("statuses/update", {
        status: `@${tweet.user.screen_name} Couldn't find the user..`,
        in_reply_to_status_id: tweet.id_str
      });
    }
    const balanceFromUser = await avn.getBalance(id(tweet.user.id_str), config.get("bot.requiredConfirms"));
    if (balanceFromUser < amount) {
      return await T.post("statuses/update", {
        status: `@${tweet.user.screen_name} You tried tipping more than you have! You are ${amount-balanceFromUser} Avian short.`,
        in_reply_to_status_id: tweet.id_str
      });
    }
    const txId = await avn.sendFrom(id(tweet.user.id_str), tipToAddress, Number(amount), 1);
    await T.post("statuses/update", {
      status: `@${tweet.user.screen_name} Tipped ${amount} Avian! We wanna say who it was, but twitter is a uk.... \nTransaction: ${txLink(txId)}`,
      in_reply_to_status_id: tweet.id_str
    });
    logger.info(
      `@${tweet.user.screen_name}(${tweet.user.id_str}) tipped ${
        msg[2]
      }(${userToTip}) ${amount} Avian.`
    );
  } catch (e) {
    logger.error(e);
  }
}

async function getAddress(userId) {
  try {
    let uAddresses = await avn.getAddressesByAccount(userId);
    if (uAddresses.length > 0) return uAddresses[0];
    let nAddress = await avn.getNewAddress(userId);
    return nAddress;
  } catch (e) {
    logger.error(e);
  }
}

function getValidatedAmount(amount) {
  amount = amount.trim();
  if (amount.toLowerCase().endsWith("avn")) {
    amount = amount.substring(0, amount.length - 3);
  }
  return amount.match(/^[0-9]+(\.[0-9]+)?$/) ? amount : null;
}
function txLink(txId) {
  return `https://explorer-ap.avn.network/tx/${txId}`;
}
function checkTrunc(tweet) {
  if (tweet.truncated) return tweet.extended_tweet.full_text;
  return tweet.text;
}

function id(usrId){
  return `t-${usrId}`;
}
