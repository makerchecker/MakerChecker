// A Solidity ABI constants file — contract metadata, NOT agent tools.
// Every entry has type:'function' + name + inputs + outputs + stateMutability.
export const ERC20_ABI = [
  {
    type: 'function',
    name: 'transfer',
    inputs: [{ name: 'to', type: 'address', internalType: 'address' }],
    outputs: [{ name: '', type: 'bool', internalType: 'bool' }],
    stateMutability: 'nonpayable',
  },
  {
    type: 'function',
    name: 'approve',
    inputs: [{ name: 'spender', type: 'address', internalType: 'address' }],
    outputs: [{ name: '', type: 'bool', internalType: 'bool' }],
    stateMutability: 'nonpayable',
  },
];
