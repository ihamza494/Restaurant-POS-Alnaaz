'use strict';
// Al Naaz Biryani menu. Edit prices here, or use the Menu screen in the app.
// Format: 'Category name': [[ 'Item name', price ], ...]  (prices are whole numbers, in Rs)
// Items and categories appear in the same order as written here.
// Load into an existing database with:  node server.js --load-menu
module.exports = {
  'Biryani': [
    ['Sada Biryani 1 Pao', 100],
    ['Sada Biryani 1.5 Pao', 150],
    ['Sada Biryani Half kg', 200],
    ['Sada Biryani 1 kg', 400],
  ],
  'Chicken Biryani': [
    ['Chicken Biryani 1 Pao', 150],
    ['Chicken Biryani 1.5 Pao', 200],
    ['Chicken Biryani 1 Pc (Half kg)', 250],
    ['Chicken Biryani 2 Pcs (Half kg)', 300],
    ['Chicken Biryani 2 Pcs (1 kg)', 500],
    ['Chicken Biryani 4 Pcs (1 kg)', 600],
  ],
  'Pulao': [
    ['Beef Pulao 1 Pao', 200],
    ['Beef Pulao 1.5 Pao', 300],
    ['Beef Pulao Half kg', 400],
    ['Beef Pulao 1 kg', 800],
  ],
  'Salad & Raita': [
    ['Salad', 50],
    ['Raita', 50],
  ],
  'Cold Drinks': [
    ['7up 345ml', 90],
    ['String 300ml', 100],
    ['Pepsi 345ml', 90],
    ['Water (Small)', 50],
    ['Water (Large)', 100],
  ],
  'Fries': [
    ['Fries Masala', 100],
    ['Fries Plain', 100],
    ['Fries Mayo', 150],
  ],
  'Burger': [
    ['Special Ban Kabab', 100],
    ['Andy Wala Burger', 140],
    ['Chicken Burger', 180],
    ['Chicken Cheese Burger', 250],
    ['Chicken Anda Burger', 220],
    ['Beef Burger', 300],
  ],
  'Special Deals': [
    ['Deal 1 (2 Chicken Biryani, 2 Drinks, 1 Salad, 2 Raita)', 700],
    ['Deal 2 (3 Chicken Biryani, 2 Raita, 3 Drinks, 1 Salad)', 850],
    ['Deal 3 (3 Chicken Biryani, 3 Raita, 3 Drinks, 2 Salad)', 1200],
    ['Deal 4 (3 Sada Biryani, 3 Raita, 3 Drinks, 2 Salad)', 1500],
  ],
};
