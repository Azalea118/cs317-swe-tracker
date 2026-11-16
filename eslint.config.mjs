import js from '@eslint/js';
import react from 'eslint-plugin-react';
import hooks from 'eslint-plugin-react-hooks';
export default [
 {ignores:['node_modules/**','dist/**']},
 js.configs.recommended,
 {files:['App.js','index.js','frontend/**/*.js'],languageOptions:{ecmaVersion:'latest',sourceType:'module',parserOptions:{ecmaFeatures:{jsx:true}},globals:Object.fromEntries(['fetch','setTimeout','clearTimeout','setInterval','clearInterval','AbortController','FormData','console','require'].map(n=>[n,'readonly']))},plugins:{react,'react-hooks':hooks},rules:{'react/jsx-uses-react':'error','react/jsx-uses-vars':'error','react-hooks/rules-of-hooks':'error','react-hooks/exhaustive-deps':'warn','no-unused-vars':['error',{argsIgnorePattern:'^_',caughtErrors:'none'}]}}
];
