'use strict';

const rand = n => Math.floor(Math.random() * n);
const pickOne = arr => arr[rand(arr.length)];

module.exports = { rand, pickOne };
