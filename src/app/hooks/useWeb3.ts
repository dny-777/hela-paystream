declare global { interface Window { ethereum: any; } }
import { useState, useEffect, useCallback } from 'react';
import { ethers } from 'ethers';
import { CONTRACT_ADDRESS, CONTRACT_ABI } from '../lib/contract';
import { supabase } from '../lib/supabase'; 

export const useWeb3 = () => {
  const [account, setAccount] = useState<string | null>(null);
  const [isOwner, setIsOwner] = useState(false);
  const [signer, setSigner] = useState<ethers.Signer | null>(null);
  const [loading, setLoading] = useState(false);
  const [isPaused, setIsPaused] = useState(false);
  const [stats, setStats] = useState({ tvl: '0', gasTank: '0', taxVault: '0', activeStreams: '0' });
  const [transactions, setTransactions] = useState<any[]>([]);

  // 💡 Pull RPC from environment for security
  const HELA_RPC = process.env.NEXT_PUBLIC_HELA_RPC || "https://testnet-rpc.helachain.com";

  // --- 1. Supabase Real-Time Streaming ---
  useEffect(() => {
    if (!account) return; 

    const loadHistory = async () => {
      try {
        const { data, error } = await supabase
          .from('protocol_ledger')
          .select('*')
          .ilike('user_address', account) 
          .order('block', { ascending: false })
          .limit(10);
        
        if (error) throw error;
        if (data) setTransactions(data);
      } catch (err) {
        console.error("Supabase load error:", err);
      }
    };
    
    loadHistory();

    const channel = supabase.channel('ledger-updates')
      .on('postgres_changes', 
        { event: 'INSERT', schema: 'public', table: 'protocol_ledger' }, 
        (payload) => {
          const newUserAddr = payload.new?.user_address;
          if (newUserAddr && account && newUserAddr.toLowerCase() === account.toLowerCase()) {
            setTransactions(prev => [payload.new, ...prev].slice(0, 10));
          }
        })
      .subscribe();

    return () => { supabase.removeChannel(channel); };
  }, [account]);

  // --- 2. Contract Stats ---
  const fetchContractStats = useCallback(async (userProvider: ethers.Provider) => {
    try {
      const contract = new ethers.Contract(CONTRACT_ADDRESS, CONTRACT_ABI, userProvider);
      const [gas, nextId, ownerAddr, paused, tvl, tax] = await Promise.all([
        account ? contract.gasSponsorshipTank(account).catch(() => BigInt(0)) : BigInt(0),
        contract.nextStreamId().catch(() => BigInt(0)),
        contract.owner().catch(() => ""),
        contract.isPaused().catch(() => false),
        contract.getProtocolTVL ? contract.getProtocolTVL().catch(() => BigInt(0)) : BigInt(0),
        contract.taxVault ? contract.taxVault(account || ethers.ZeroAddress).catch(() => BigInt(0)) : BigInt(0)
      ]);

      setStats({ 
        tvl: ethers.formatEther(tvl), 
        gasTank: ethers.formatEther(gas), 
        taxVault: ethers.formatEther(tax), 
        activeStreams: nextId.toString() 
      });
      setIsPaused(paused);
      if (account) setIsOwner(account.toLowerCase() === ownerAddr.toLowerCase());
    } catch (err) { console.warn("Stats hydration error:", err); }
  }, [account]);

  // --- 3. Actions ---

  const pushBonus = async (streamId: number, amount: string) => {
    if (!signer || !account) return;
    try {
      const contract = new ethers.Contract(CONTRACT_ADDRESS, CONTRACT_ABI, signer);
      const tx = await contract.pushBonus(
        streamId, 
        ethers.parseUnits(amount, "ether"), 
        { gasLimit: 300000 }
      );
      const receipt = await tx.wait(); 

      await supabase.from('protocol_ledger').insert([{
        type: "Performance Bonus",
        hash: receipt.hash,
        block: parseInt(receipt.blockNumber.toString()),
        user_address: account
      }]);

      await fetchContractStats(signer.provider as ethers.Provider);
    } catch (err) { console.error("Bonus failed:", err); }
  };

  const refillGasTank = async (amount: string) => {
    if (!signer || !account) return;
    try {
      const contract = new ethers.Contract(CONTRACT_ADDRESS, CONTRACT_ABI, signer);
      const tx = await contract.fundGasTank({ 
        value: ethers.parseUnits(amount, "ether"), 
        gasLimit: 300000 
      });
      const receipt = await tx.wait(); 

      await supabase.from('protocol_ledger').insert([{
        type: "Gas Tank Refill",
        hash: receipt.hash,
        block: parseInt(receipt.blockNumber.toString()), 
        user_address: account 
      }]);

      await fetchContractStats(signer.provider as ethers.Provider);
    } catch (err) { console.error("Refill failed:", err); }
  };

  const createNewStream = async (recipient: string, amount: string) => {
    if (!signer || !account) return;
    try {
      const contract = new ethers.Contract(CONTRACT_ADDRESS, CONTRACT_ABI, signer);
      const totalValue = ethers.parseUnits(amount, "ether");
      const tx = await contract.createBatchStreams(
        [recipient], 
        [totalValue / BigInt(2592000)], 
        [10], 
        [totalValue], 
        { value: totalValue, gasLimit: 800000 }
      );
      const receipt = await tx.wait();

      await supabase.from('protocol_ledger').insert([{
        type: "New Stream Created",
        hash: receipt.hash,
        block: parseInt(receipt.blockNumber.toString()),
        user_address: account
      }]);

      await fetchContractStats(signer.provider as ethers.Provider);
    } catch (err) { console.error("Stream failed:", err); }
  };

  const claimEarnings = async (streamId: number) => {
    if (!signer || !account) return;
    try {
      const contract = new ethers.Contract(CONTRACT_ADDRESS, CONTRACT_ABI, signer);
      const tx = await contract.claimFunds(streamId, { gasLimit: 500000 });
      const receipt = await tx.wait(); 

      await supabase.from('protocol_ledger').insert([{
        type: "Salary Withdrawal",
        hash: receipt.hash,
        block: parseInt(receipt.blockNumber.toString()),
        user_address: account
      }]);

      await fetchContractStats(signer.provider as ethers.Provider);
    } catch (err) { console.error("Claim failed:", err); }
  };

  const togglePause = async () => {
    if (!signer) return;
    const contract = new ethers.Contract(CONTRACT_ADDRESS, CONTRACT_ABI, signer);
    const tx = await contract.togglePause({ gasLimit: 200000 });
    const receipt = await tx.wait(); 

    await supabase.from('protocol_ledger').insert([{
      type: isPaused ? "Protocol Resumed" : "Emergency Pause",
      hash: receipt.hash,
      block: parseInt(receipt.blockNumber.toString()),
      user_address: account
    }]);

    await fetchContractStats(signer.provider as ethers.Provider);
  };

  // --- 4. System Functions ---
  const connectWallet = async () => {
    if (typeof window !== 'undefined' && window.ethereum) {
      try {
        setLoading(true);
        const provider = new ethers.BrowserProvider(window.ethereum);
        const accounts = await provider.send("eth_requestAccounts", []);
        const userSigner = await provider.getSigner();
        setAccount(accounts[0]); setSigner(userSigner);
        await fetchContractStats(provider);
      } catch (err) { console.error("Connect failed:", err); } finally { setLoading(false); }
    }
  };

  const disconnectWallet = () => {
    setAccount(null); setSigner(null); setIsOwner(false);
    setStats({ tvl: '0', gasTank: '0', taxVault: '0', activeStreams: '0' });
    setTransactions([]);
  };

  useEffect(() => {
    const init = async () => {
      if (typeof window !== 'undefined' && window.ethereum) {
        const provider = new ethers.BrowserProvider(window.ethereum);
        const accounts = await provider.send("eth_accounts", []);
        if (accounts.length > 0) {
          const userSigner = await provider.getSigner();
          setAccount(accounts[0]); setSigner(userSigner);
          await fetchContractStats(provider);
        }
      }
    };
    init();
  }, [fetchContractStats]);

  return {
    account, isOwner, signer, loading, stats, transactions, isPaused,
    connectWallet, disconnectWallet, createNewStream, claimEarnings, refillGasTank, pushBonus, togglePause
  };
};