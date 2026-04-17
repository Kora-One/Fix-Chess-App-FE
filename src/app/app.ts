import { Component, ChangeDetectorRef } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { HttpClient } from '@angular/common/http';
import { RouterOutlet } from '@angular/router';
import { marked } from 'marked'; // <-- 1. Import the library here

@Component({
  selector: 'app-root',
  standalone: true,
  imports: [RouterOutlet, CommonModule, FormsModule],
  templateUrl: './app.html',
  styleUrl: './app.css'
})
export class App {
  username = '';
  report = '';
  loading = false;

  constructor(private http: HttpClient, private cdr: ChangeDetectorRef) {}

  getAnalysis() {
    if (!this.username) return;
    
    this.loading = true;
    this.report = '';
    this.cdr.detectChanges();
    
    const backendUrl = `https://chess-backend.gentlestone-e692d061.centralindia.azurecontainerapps.io/api/analyze/${this.username}`;
    
    this.http.get(backendUrl, { responseType: 'text' }).subscribe({
      next: async (data) => {
        // 2. Convert the raw Markdown text into beautiful HTML
        this.report = await marked.parse(data); 
        this.loading = false;
        this.cdr.detectChanges();
      },
      error: (err) => {
        console.error('HTTP Error:', err);
        this.report = '❌ Failed to fetch analysis.';
        this.loading = false;
        this.cdr.detectChanges();
      }
    });
  }
}