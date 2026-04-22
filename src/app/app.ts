import { Component, ChangeDetectorRef, ViewChild, ElementRef, CUSTOM_ELEMENTS_SCHEMA } from '@angular/core';
import { DecimalPipe } from '@angular/common'; 
import { FormsModule } from '@angular/forms';
import { HttpClient } from '@angular/common/http';
import { Subscription } from 'rxjs'; 
import { marked } from 'marked'; 
import { Chess } from 'chess.js';
import Chart from 'chart.js/auto';
import { environment } from '../environments/environment';
import 'chessboard-element'; // The modern, native Web Component board!

@Component({
  selector: 'app-root',
  standalone: true,
  imports: [DecimalPipe, FormsModule], 
  schemas: [CUSTOM_ELEMENTS_SCHEMA], // Tells Angular to allow native <chess-board> HTML tags
  templateUrl: './app.html',
  styleUrls: ['./app.css']
})
export class App {
  // --- UI State ---
  username = '';
  analyzingUsername = '';
  report = '';
  selectedPlatform = '';
  showPlatformError = false;
  selectedMood = '';
  showMoodError = false;
  activeTab = 'analysis';
  noGamesFound = false;

  // --- Loading & Graph State ---
  loading = false;
  progressPercentage = 0;
  private progressInterval: any;
  
  trendChart: any;
  openChart: any;
  midChart: any;
  endChart: any;
  trendLoading = false;
  trendProgress = 0;

  overallStats = { wins: 0, draws: 0, losses: 0, winPct: 0, drawPct: 0, lossPct: 0 };
  openingStats: any[] = [];
  openingLoading = false;

  apiError = false;

  cardData = { rating: 0, animal: '♟️', tagline: '' };

  // --- PUZZLE STATE ---
  puzzles: any[] = [];
  currentPuzzleIndex = 0;
  @ViewChild('board') boardView!: ElementRef;

  // --- Cancellation Tracking ---
  private currentAnalysisId = 0; 
  private activeWorkers: Worker[] = [];
  private analysisSub?: Subscription;

  constructor(private http: HttpClient, private cdr: ChangeDetectorRef) {}

  selectPlatform(p: string) { this.selectedPlatform = p; this.showPlatformError = false; }
  selectMood(m: string) { this.selectedMood = m; this.showMoodError = false; }

  switchTab(tab: string) { 
    this.activeTab = tab; 
    this.cdr.detectChanges(); 
    setTimeout(() => { 
      if (tab === 'trend') {
        if (this.trendChart) this.trendChart.resize();
        if (this.openChart) this.openChart.resize();
        if (this.midChart) this.midChart.resize();
        if (this.endChart) this.endChart.resize();
      } else if (tab === 'puzzles' && this.puzzles.length > 0) {
        this.loadPuzzle(this.currentPuzzleIndex); // Load the board when tab is clicked
      }
    }, 50);
  }

  cancelCurrentAnalysis() {
    this.currentAnalysisId++;
    this.analysisSub?.unsubscribe();
    this.activeWorkers.forEach(w => w.terminate());
    this.activeWorkers = [];
    this.loading = this.trendLoading = this.openingLoading = this.noGamesFound = false;
    this.puzzles = [];
    this.loading = this.trendLoading = this.openingLoading = this.noGamesFound = this.apiError = false;
    clearInterval(this.progressInterval);
  }

  getAnalysis() {
    if (!this.selectedPlatform) { this.showPlatformError = true; return; }
    if (!this.username) return;
    if (!this.selectedMood) { this.showMoodError = true; return; }
    
    this.cancelCurrentAnalysis();
    this.analyzingUsername = this.username; 
    this.loading = true;
    this.report = '';
    this.activeTab = 'analysis'; 
    this.startFakeProgress();
    
    const pgnsPromise = this.fetchMultipleGames(20);
    this.generateTrendGraph(pgnsPromise);
    this.generateOpeningGraph(pgnsPromise);
    this.fetchPlayerStats();

    const backendUrl = `${environment.apiUrl}/analyze/${this.selectedPlatform}/${this.username}/${this.selectedMood}`;
    this.analysisSub = this.http.get(backendUrl, { responseType: 'text' }).subscribe({
      next: async (data) => {
        this.finishProgress();
        
        // If your backend specifically sends a text error starting with "Error"
        if (data.startsWith("Error")) {
            // Check if the text implies a server/API issue
            if (data.includes("503") || data.includes("500") || data.toLowerCase().includes("server")) {
                this.apiError = true;
            } else {
                this.noGamesFound = true;
            }
            this.report = '';
        } else {
            this.report = await marked.parse(data); 
        }
        this.cdr.detectChanges();
      },
      error: (err) => {
        this.finishProgress();
        // ⚡ NEW: If it's a 500, 503, or 504 from your Spring Boot server, show the API error!
        if (err.status >= 500 || err.status === 0) {
            this.apiError = true;
        } else {
            this.noGamesFound = true; // 404s usually mean the user wasn't found
        }
        this.cdr.detectChanges();
      }
    });
  }

  // --- 20 GAME TREND GRAPH ---
  async generateTrendGraph(pgnsPromise: Promise<string[]>) {
    this.trendLoading = true;
    this.trendProgress = 0;
    this.puzzles = []; 
    
    if (this.trendChart) this.trendChart.destroy();
    if (this.openChart) this.openChart.destroy();
    if (this.midChart) this.midChart.destroy();
    if (this.endChart) this.endChart.destroy();

    const thisAnalysis = this.currentAnalysisId; 
    const pgns = await pgnsPromise;
    
    if (this.currentAnalysisId !== thisAnalysis) return; 
    
    if (!pgns.length) {
      this.noGamesFound = true;
      this.trendLoading = false;
      return;
    }

    const accOverall: number[] = [];
    const accOpen: (number | null)[] = [];
    const accMid: (number | null)[] = [];
    const accEnd: (number | null)[] = [];
    const gameLabels: string[] = [];

    for (let i = 0; i < pgns.length; i++) {
      if (this.currentAnalysisId !== thisAnalysis) return; 
      
      const result = await this.calculateSingleGameAccuracy(pgns[i], this.username);
      
      accOverall.push(result.overall);
      accOpen.push(result.opening);
      accMid.push(result.midgame);
      accEnd.push(result.endgame);
      gameLabels.push(`Game ${i + 1}`);

      // Extract the worst blunder from this game for the puzzle tab
      if (result.blunder) {
        this.puzzles.push({
          ...result.blunder,
          gameNumber: i + 1,
          status: 'pending' 
        });
      }
      
      this.trendProgress = Math.round(((i + 1) / pgns.length) * 100);
      this.cdr.detectChanges();
    }

    this.trendLoading = false;
    this.cdr.detectChanges();
    
    setTimeout(() => { 
      if (this.currentAnalysisId === thisAnalysis) {
        this.drawTrendChart(gameLabels, accOverall);
        this.drawPhaseCharts(gameLabels, accOpen, accMid, accEnd);
        
        // ⚡ NEW: The moment the loading finishes, force the first puzzle to load!
        if (this.puzzles.length > 0) {
          this.loadPuzzle(0);
        }
      }
    }, 50);
  }

  calculateSingleGameAccuracy(pgn: string, playerUsername: string): Promise<{overall: number, opening: number | null, midgame: number | null, endgame: number | null, blunder: any}> {
    const chess = new Chess();
    try { chess.loadPgn(pgn); } catch (e) { return Promise.resolve({overall:0, opening:null, midgame:null, endgame:null, blunder:null}); }

    const isWhite = (chess.header() as any)["White"]?.toLowerCase() === playerUsername.toLowerCase();
    const historySan = chess.history(); 
    const fens = [new Chess().fen()]; 
    const tempChess = new Chess();
    historySan.forEach(move => { tempChess.move(move); fens.push(tempChess.fen()); });

    const worker = new Worker("stockfish.js");
    this.activeWorkers.push(worker); 

    let currentFenIndex = 0, previousWhiteEval = 0, currentWhiteEval = 0; 
    let previousBestMove = "";
    let maxLoss = 0;
    let gameBlunder: any = null;
    
    const openAcc: number[] = [];
    const midAcc: number[] = [];
    const endAcc: number[] = [];

    return new Promise((resolve) => {
      let failsafeTimer: any;
      
      const finish = () => {
        clearTimeout(failsafeTimer);
        worker.terminate();
        this.activeWorkers = this.activeWorkers.filter(w => w !== worker);
        
        const calcAvg = (arr: number[]) => arr.length ? Math.round(arr.reduce((a, b) => a + b, 0) / arr.length) : null;
        const totalArr = [...openAcc, ...midAcc, ...endAcc];
        
        resolve({
          overall: calcAvg(totalArr) || 0,
          opening: calcAvg(openAcc),
          midgame: calcAvg(midAcc),
          endgame: calcAvg(endAcc),
          blunder: gameBlunder 
        });
      };

      const resetFailsafe = () => {
        clearTimeout(failsafeTimer);
        failsafeTimer = setTimeout(finish, currentFenIndex === fens.length - 1 ? 100 : 5000); 
      };

      worker.onmessage = (event) => {
        const line = event.data;
        const isBlackTurn = fens[currentFenIndex].includes(' b ');

        if (line.includes("score cp")) {
          const cp = parseInt(line.match(/score cp (-?\d+)/)?.[1] || "0");
          currentWhiteEval = isBlackTurn ? -cp : cp;
        } else if (line.includes("score mate")) {
          const mate = parseInt(line.match(/score mate (-?\d+)/)?.[1] || "0");
          currentWhiteEval = isBlackTurn ? -(mate > 0 ? 10000 : -10000) : (mate > 0 ? 10000 : -10000);
        }

        if (line.startsWith("bestmove")) {
          const bestMoveMatch = line.match(/bestmove\s+(\S+)/);
          const currentBestMove = bestMoveMatch ? bestMoveMatch[1] : "";

          if (currentFenIndex > 0) {
            let loss = 0;
            if (isWhite && isBlackTurn) loss = previousWhiteEval - currentWhiteEval; 
            else if (!isWhite && !isBlackTurn) loss = currentWhiteEval - previousWhiteEval;

            if ((isWhite && isBlackTurn) || (!isWhite && !isBlackTurn)) {
              const accuracy = 100 * Math.exp(-Math.max(0, loss) / 200);
              const moveNumber = Math.ceil(currentFenIndex / 2);
              
              if (moveNumber <= 10) openAcc.push(accuracy);
              else if (moveNumber <= 30) midAcc.push(accuracy);
              else endAcc.push(accuracy);

              // If the loss is worse than 1.5 pawns, record it as a blunder
              if (loss > 150 && loss > maxLoss) {
                maxLoss = loss;
                gameBlunder = {
                    fen: fens[currentFenIndex - 1], 
                    playedMove: historySan[currentFenIndex - 1], 
                    bestMove: previousBestMove 
                };
              }
            }
          }
          previousBestMove = currentBestMove;
          previousWhiteEval = currentWhiteEval;
          currentFenIndex++;

          if (currentFenIndex < fens.length) {
            resetFailsafe(); 
            worker.postMessage(`position fen ${fens[currentFenIndex]}`);
            worker.postMessage("go depth 10"); 
          } else {
            finish();
          }
        }
      };

      resetFailsafe();
      worker.postMessage("uci");
      worker.postMessage(`position fen ${fens[currentFenIndex]}`);
      worker.postMessage("go depth 10");
    });
  }

  // --- PUZZLE LOGIC ---
  loadPuzzle(index: number) {
    this.currentPuzzleIndex = index;
    this.cdr.detectChanges(); 
    
    // ⚡ Bumped to 100ms to guarantee Angular has fully drawn the HTML before we try to modify it
    setTimeout(() => {
      if (this.boardView) {
        const board = this.boardView.nativeElement;
        
        // ⚡ FIX: Use the strict property setter for the Web Component
        board.position = this.puzzles[index].fen;
        
        // Auto-flip the board if it's Black's turn!
        board.orientation = this.puzzles[index].fen.includes(' b ') ? 'black' : 'white';
      }
    }, 100); 
  }

  onPuzzleMove(event: any) {
    const puzzle = this.puzzles[this.currentPuzzleIndex];
    if (puzzle.status === 'solved') {
      event.detail.setAction('snapback'); // Prevent moving pieces after solved
      return;
    }

    const source = event.detail.source; 
    const target = event.detail.target; 
    const userUci = source + target; 

    if (this.checkMoveMatch(userUci, puzzle.bestMove)) {
      puzzle.status = 'solved';
    } else {
      puzzle.status = 'failed';
      event.detail.setAction('snapback'); // Snaps the piece back to its original square
    }
  }

  checkMoveMatch(userUci: string, stockfishUci: string): boolean {
    return stockfishUci.startsWith(userUci);
  }

  flipBoard() {
    if (this.boardView) {
      const board = this.boardView.nativeElement;
      board.orientation = board.orientation === 'white' ? 'black' : 'white';
    }
  }

  // --- OPENING REPERTOIRE GRAPH ---
  async generateOpeningGraph(pgnsPromise: Promise<string[]>) {
    this.openingLoading = true;
    this.openingStats = []; 
    this.overallStats = { wins: 0, draws: 0, losses: 0, winPct: 0, drawPct: 0, lossPct: 0 };
    const thisAnalysis = this.currentAnalysisId; 

    const pgns = await pgnsPromise;
    if (this.currentAnalysisId !== thisAnalysis) return; 

    if (!pgns.length) {
      this.openingLoading = false;
      return;
    }

    const stats: Record<string, any> = {};
    pgns.forEach(pgn => {
      const chess = new Chess();
      try { chess.loadPgn(pgn); } catch (e) { return; }

      const headers = chess.header() as any;
      const isWhite = headers['White']?.toLowerCase() === this.username.toLowerCase();
      const result = headers['Result']; 
      
      let opening = headers['Opening'] || headers['ECOUrl']?.match(/\/openings\/([^/]+)/)?.[1]?.split(/-\d+\./)[0].replace(/-/g, ' ') || headers['ECO'] || 'Unknown Opening';
      const colorPlayed = isWhite ? 'White' : 'Black';
      const key = `${opening.split(':')[0].trim()}-${colorPlayed}`;

      if (!stats[key]) stats[key] = { id: key, name: opening.split(':')[0].trim(), color: colorPlayed, wins: 0, losses: 0, draws: 0 };

      if (result === '1/2-1/2') { stats[key].draws++; this.overallStats.draws++; } 
      else if ((isWhite && result === '1-0') || (!isWhite && result === '0-1')) { stats[key].wins++; this.overallStats.wins++; } 
      else { stats[key].losses++; this.overallStats.losses++; }
    });

    const t = this.overallStats.wins + this.overallStats.draws + this.overallStats.losses;
    if (t > 0) {
      this.overallStats.winPct = (this.overallStats.wins / t) * 100;
      this.overallStats.drawPct = (this.overallStats.draws / t) * 100;
      this.overallStats.lossPct = (this.overallStats.losses / t) * 100;
    }

    this.openingStats = Object.values(stats).map((s: any) => {
      const total = s.wins + s.losses + s.draws;
      return { ...s, total, winPct: (s.wins / total) * 100, drawPct: (s.draws / total) * 100, lossPct: (s.losses / total) * 100 };
    }).sort((a, b) => b.total - a.total); 

    this.openingLoading = false;
    this.cdr.detectChanges();
  }

  // --- API HELPER ---
  async fetchMultipleGames(limit: number): Promise<string[]> {
    try {
      const res = await fetch(`${environment.apiUrl}/games/${this.selectedPlatform}/${this.username}?limit=${limit}`);
      if (!res.ok) return [];
      return await res.json();
    } catch (e) { return []; }
  }

  // --- CHARTS ---
  drawTrendChart(labels: string[], data: number[]) {
    const canvas = document.getElementById('trendChart') as HTMLCanvasElement;
    if (!canvas) return;
    this.trendChart = new Chart(canvas, {
      type: 'line',
      data: {
        labels: labels,
        datasets: [{
          label: 'Overall Accuracy %', data: data, borderColor: '#2563eb', backgroundColor: 'rgba(37, 99, 235, 0.1)',
          borderWidth: 3, pointBackgroundColor: '#2563eb', pointRadius: 5, fill: true, tension: 0.4 
        }]
      },
      options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { display: false } }, scales: { y: { min: 0, max: 100 } } }
    });
  }

  drawPhaseCharts(labels: string[], open: (number|null)[], mid: (number|null)[], end: (number|null)[]) {
    const createChart = (id: string, label: string, color: string, data: (number|null)[], chartRef: string) => {
      const canvas = document.getElementById(id) as HTMLCanvasElement;
      if (!canvas) return;
      (this as any)[chartRef] = new Chart(canvas, {
        type: 'line',
        data: {
          labels: labels,
          datasets: [{
            label: label, data: data, borderColor: color, backgroundColor: color + '1a',
            borderWidth: 2, pointBackgroundColor: color, pointRadius: 3, fill: true, tension: 0.4, 
            spanGaps: true
          }]
        },
        options: { 
          responsive: true, maintainAspectRatio: false, 
          plugins: { legend: { display: false }, title: { display: true, text: label, color: '#64748b', font: {size: 14} } }, 
          scales: { y: { min: 0, max: 100, ticks: { display: false } }, x: { ticks: { display: false } } } 
        }
      });
    };
    createChart('openChart', 'Opening (Moves 1-10)', '#10b981', open, 'openChart'); 
    createChart('midChart', 'Middlegame (Moves 11-30)', '#f59e0b', mid, 'midChart'); 
    createChart('endChart', 'Endgame (Moves 31+)', '#8b5cf6', end, 'endChart');     
  }

  // --- UI LOADERS ---
  private startFakeProgress() {
    this.progressPercentage = 0;
    this.progressInterval = setInterval(() => {
      if (this.progressPercentage < 95) {
        this.progressPercentage = Math.min(this.progressPercentage + (Math.random() * 2), 95);
        this.cdr.detectChanges();
      }
    }, 250); 
  }
  
  private finishProgress() { 
    clearInterval(this.progressInterval); 
    this.progressPercentage = 100; 
    setTimeout(() => { this.loading = false; this.cdr.detectChanges(); }, 600); 
  }

  // --- PLAYER CARD LOGIC ---
  async fetchPlayerStats() {
    try {
      const statsRes = await fetch(`${environment.apiUrl}/stats/${this.selectedPlatform}/${this.username}`);
      const data = statsRes.ok ? await statsRes.json() : { rating: 1200 };
      this.cardData.rating = data.rating || 1200;

      const currentMood = this.selectedMood || 'straight';
      const identityRes = await fetch(`${environment.apiUrl}/identity/${this.username}/${this.cardData.rating}/${currentMood}`);
      
      if (identityRes.ok) {
        const idData = await identityRes.json();
        this.cardData.animal = idData.animal;
        this.cardData.tagline = idData.tagline;
      } else {
        throw new Error("AI Identity fetch failed");
      }
    } catch (e) { 
      this.cardData.rating = this.cardData.rating || 1200; 
      this.cardData.animal = '♟️';
      this.cardData.tagline = 'A mysterious tactician on the board.';
    }
  }

  downloadCard() { window.location.href = `${environment.apiUrl}/card/${this.selectedPlatform}/${this.analyzingUsername}`; }
}