/**
 * Copyright 2017–2018, LaborX PTY
 * Licensed under the AGPL Version 3 license.
 * @author Egor Zuev <zyev.egor@gmail.com>
 */

require('dotenv/config');

const config = require('../config'),
  models = require('../models'),
  bcoin = require('bcoin'),
  spawn = require('child_process').spawn,
  fuzzTests = require('./fuzz'),
  //performanceTests = require('./performance'),
  featuresTests = require('./features'),
  Network = require('bcoin/lib/protocol/network'),
  //blockTests = require('./blocks'),
  Promise = require('bluebird'),
  mongoose = require('mongoose'),
  amqp = require('amqplib'),
  ctx = {};

mongoose.Promise = Promise;
mongoose.connect(config.mongo.data.uri, {useMongoClient: true});
mongoose.accounts = mongoose.createConnection(config.mongo.accounts.uri, {useMongoClient: true});


describe('core/blockProcessor', function () {

  before(async () => {
    models.init();
    ctx.network = Network.get('regtest');
    ctx.keyPair = bcoin.hd.generate(ctx.network);
    ctx.keyPair2 = bcoin.hd.generate(ctx.network);
    ctx.amqp = {};
    ctx.amqp.instance = await amqp.connect(config.rabbit.url);
    ctx.amqp.channel = await ctx.amqp.instance.createChannel();
    await ctx.amqp.channel.assertExchange('events', 'topic', {durable: false});
  });

  after(async () => {
    mongoose.disconnect();
    mongoose.accounts.close();
    await ctx.amqp.instance.close();
  });


/*
  describe('block', () => blockTests(ctx));

  describe('performance', () => performanceTests(ctx));
*/
  describe('fuzz', () => fuzzTests(ctx));

  describe('features', () => featuresTests(ctx));

});
