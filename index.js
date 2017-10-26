const config = require('./config'),
  mongoose = require('mongoose'),
  fetchBalanceService = require('./services/fetchBalanceService'),
  fetchTXService = require('./services/fetchTXService'),
  accountModel = require('./models/accountModel'),
  bunyan = require('bunyan'),
  Promise = require('bluebird'),
  _ = require('lodash'),
  log = bunyan.createLogger({name: 'core.balanceProcessor'}),
  amqp = require('amqplib');

/**
 * @module entry point
 * @description update balances for addresses, which were specified
 * in received transactions from blockParser via amqp
 */

mongoose.Promise = Promise;
mongoose.connect(config.mongo.uri, {useMongoClient: true});

let init = async () => {
  let conn = await amqp.connect(config.rabbit.url);
  let channel = await conn.createChannel();

  try {
    await channel.assertExchange('events', 'topic', {durable: false});
    await channel.assertQueue(`app_${config.rabbit.serviceName}.balance_processor.tx`);
    await channel.bindQueue(`app_${config.rabbit.serviceName}.balance_processor.tx`, 'events', `${config.rabbit.serviceName}_transaction.*`);
  } catch (e) {
    log.error(e);
    channel = await conn.createChannel();
  }

  try {
    await channel.assertQueue(`app_${config.rabbit.serviceName}.balance_processor.block`);
    await channel.bindQueue(`app_${config.rabbit.serviceName}.balance_processor.block`, 'events', `${config.rabbit.serviceName}_block`);
  } catch (e) {
    log.error(e);
    channel = await conn.createChannel();
  }

  channel.prefetch(2);

  channel.consume(`app_${config.rabbit.serviceName}.balance_processor.block`, async data => {
    try {
      let payload = JSON.parse(data.content.toString());

      let accounts = await accountModel.find({
        $where: 'obj.lastTxs.length > 0',
        lastBlockCheck: {$lt: payload.block}
      });

      for (let account of accounts) {
        let balances = await fetchBalanceService(account.address);

        let filteredLastTxs = _.filter(account.lastTxs, item => {
          let heightDiff = payload.block - item.blockHeight;
          return heightDiff === 3 || heightDiff === 6;
        });

        for (let filteredLastTx of filteredLastTxs) {
          let txHash = filteredLastTx.txid;
          let tx = await fetchTXService(txHash);

          tx.inputs = await Promise.mapSeries(tx.vin, async vin => {
            if (vin.coinbase)
              return {
                value: _.get(tx, 'vout.0.value'),
                addresses: null
              };
            let vinTx = await fetchTXService(vin.txid);
            return vinTx.vout[vin.vout];
          });

          tx.outputs = tx.vout.map(v => ({
            value: Math.floor(v.value * Math.pow(10, 8)),
            scriptPubKey: v.scriptPubKey,
            addresses: v.scriptPubKey.addresses
          }));

          for (let i = 0; i < tx.inputs.length; i++) {
            tx.inputs[i] = {
              addresses: _.get(tx.inputs[i], 'scriptPubKey.addresses', null),
              prev_hash: tx.vin[i].txid,
              script: tx.inputs[i].scriptPubKey,
              value: Math.floor(tx.inputs[i].value * Math.pow(10, 8)),
              output_index: tx.vin[i].vout
            };
          }

          tx.valueIn = _.chain(tx.inputs)
            .map(i => i.value)
            .sum()
            .value();

          tx.valueOut = _.chain(tx.outputs)
            .map(i => i.value)
            .sum()
            .value();

          tx.fee = tx.valueIn - tx.valueOut;
          tx = _.omit(tx, ['vin', 'vout', 'blockhash']);

          tx.fee = tx.valueIn - tx.valueOut;

          let savedAccount = await accountModel.findOneAndUpdate({address: account.address}, {
            $set: _.chain([
              {'balances.confirmations0': balances.balances.confirmations0, min: 0},
              {'balances.confirmations3': balances.balances.confirmations3, min: 3},
              {'balances.confirmations6': balances.balances.confirmations6, min: 6}
            ])
              .transform((result, item) => {
                if (tx.confirmations >= item.min)
                  Object.assign(result, item);
              }, {})
              .omit('min')
              .value()
          }, {new: true});

          channel.publish('events', `${config.rabbit.serviceName}_balance.${payload.address}`, new Buffer(JSON.stringify({
            address: payload.address,
            balances: savedAccount.balances,
            tx: tx
          })));
        }

        await accountModel.update({address: account.address}, {
          $set: {
            lastBlockCheck: payload.block,
            lastTxs: _.filter(account.lastTxs, item => payload.block - item.blockHeight <= 6)
          }
        });
      }

    } catch (e) {
      log.error(e);
    }

    channel.ack(data);
  });

  channel.consume(`app_${config.rabbit.serviceName}.balance_processor.tx`, async (data) => {
    try {
      let payload = JSON.parse(data.content.toString());
      let balances = await fetchBalanceService(payload.address);

      let account = await accountModel.findOne({address: payload.address});

      let newTxHashes = _.chain(payload)
        .get('txs')
        .reject(txHash =>
          _.chain(account)
            .get('lastTxs', [])
            .find({txid: txHash})
            .value()
        )
        .value();

      for (let txHash of newTxHashes) {

        let tx = await fetchTXService(txHash);

        tx.inputs = await Promise.mapSeries(tx.vin, async vin => {
          if (vin.coinbase)
            return {
              value: _.get(tx, 'vout.0.value'),
              addresses: null
            };

          let vinTx = await fetchTXService(vin.txid);
          return vinTx.vout[vin.vout];
        });

        tx.outputs = tx.vout.map(v => ({
          value: Math.floor(v.value * Math.pow(10, 8)),
          scriptPubKey: v.scriptPubKey,
          addresses: v.scriptPubKey.addresses
        }));

        for (let i = 0; i < tx.inputs.length; i++) {
          tx.inputs[i] = {
            addresses: _.get(tx.inputs[i], 'scriptPubKey.addresses', null),
            prev_hash: tx.vin[i].txid,
            script: tx.inputs[i].scriptPubKey,
            value: Math.floor(tx.inputs[i].value * Math.pow(10, 8)),
            output_index: tx.vin[i].vout
          };
        }

        tx.valueIn = _.chain(tx.inputs)
          .map(i => i.value)
          .sum()
          .value();

        tx.valueOut = _.chain(tx.outputs)
          .map(i => i.value)
          .sum()
          .value();

        tx.fee = tx.valueIn - tx.valueOut;
        tx = _.omit(tx, ['vin', 'vout', 'blockhash']);

        let savedAccount = await accountModel.findOneAndUpdate({
          address: payload.address,
          lastBlockCheck: {$lte: balances.lastBlockCheck}
        }, {
          $set: _.chain([
            {'balances.confirmations0': balances.balances.confirmations0, min: 0},
            {'balances.confirmations3': balances.balances.confirmations3, min: 3},
            {'balances.confirmations6': balances.balances.confirmations6, min: 6}
          ])
            .transform((result, item) => {
              if (tx.confirmations >= item.min)
                Object.assign(result, item);
            }, {})
            .omit('min')
            .merge({
              lastBlockCheck: balances.lastBlockCheck,
              lastTxs: _.chain(tx)
                .thru(tx =>
                  [({txid: tx.hash, blockHeight: tx.block})]
                )
                .union(_.get(account, 'lastTxs', []))
                .uniqBy('txid')
                .value()
            })
            .value()
        }, {new: true});

        channel.publish('events', `${config.rabbit.serviceName}_balance.${payload.address}`, new Buffer(JSON.stringify({
          address: payload.address,
          balances: savedAccount.balances,
          tx: tx
        })));

      }

      log.info(`balance updated for ${payload.address}`);
    } catch (e) {
      log.error(e);
    }
    channel.ack(data);
  });

};

module.exports = init();
