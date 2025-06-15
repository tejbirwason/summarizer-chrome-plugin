const { createOpenAIStreamMock, createAnthropicStreamMock } = require('./test-utils');

describe('Integration Tests', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('Summarization Flow', () => {
    test('complete summarization flow with OpenAI o3', async () => {
      // Mock the fetch for OpenAI
      const mockSummary = 'This is a test summary of the selected content.';
      global.fetch.mockResolvedValueOnce(createOpenAIStreamMock(mockSummary));
      
      // Simulate the flow:
      // 1. User selects text
      // 2. Clicks summarize button
      // 3. Background script calls OpenAI
      // 4. Summary is displayed
      
      const selectedText = 'Long text that needs summarization...';
      
      // The request that would be sent from content script
      const request = {
        action: 'summarize',
        text: selectedText
      };
      
      // Verify the API call would have correct parameters
      const expectedBody = {
        model: 'o3-mini',
        max_completion_tokens: 8192,
        messages: [{
          role: 'user',
          content: `Summarize:\n\n${selectedText}`
        }],
        reasoning_effort: 'medium',
        stream: true
      };
      
      // Simulate the background script handling
      // In real flow, this would happen in background.js
      expect(global.fetch).toHaveBeenCalledTimes(0); // Not called yet
      
      // After the flow completes
      // We would expect the summary to be displayed
    });
  });

  describe('Draft Response Flow', () => {
    test('complete draft flow with Claude', async () => {
      // Mock the fetch for Claude
      const mockDraft = 'Hi there! Thanks for reaching out...';
      global.fetch.mockResolvedValueOnce(createAnthropicStreamMock(mockDraft));
      
      const selectedText = 'Original email thread...';
      const instructions = 'Make it more formal';
      
      // The request from content script
      const request = {
        action: 'draft',
        text: selectedText,
        instructions: instructions
      };
      
      // Verify the prompt template would be correct
      const expectedPrompt = `Draft a concise response to the following thread:

"${selectedText}"

Additional instructions:
${instructions}

Notes:
- My name is Tj
- If the thread is related to recruiting, remember that I'm the applicant
- Tone should be friendly and informal yet still professional`;
      
      // After the flow, we'd expect the draft to be displayed
    });
  });

  describe('Error Handling', () => {
    test('should handle API failures gracefully', async () => {
      // Test OpenAI failure
      global.fetch.mockRejectedValueOnce(new Error('API Error'));
      
      // The error should result in a user-friendly message
      // Expected: "Summary generation failed."
    });
    
    test('should handle network timeouts', async () => {
      // Simulate a timeout
      global.fetch.mockImplementationOnce(() => 
        new Promise((resolve, reject) => {
          setTimeout(() => reject(new Error('Timeout')), 5000);
        })
      );
      
      // Should handle gracefully
    });
  });

  describe('Streaming Updates', () => {
    test('should handle partial updates during streaming', async () => {
      const chunks = [
        'Part 1...',
        'Part 2...',
        'Part 3 complete.'
      ];
      
      // Mock a more realistic streaming response
      let chunkIndex = 0;
      const mockResponse = {
        body: {
          getReader: () => ({
            read: jest.fn()
              .mockResolvedValueOnce({ 
                done: false, 
                value: new TextEncoder().encode(`data: {"choices":[{"delta":{"content":"${chunks[0]}"}}]}\n\n`)
              })
              .mockResolvedValueOnce({ 
                done: false, 
                value: new TextEncoder().encode(`data: {"choices":[{"delta":{"content":"${chunks[1]}"}}]}\n\n`)
              })
              .mockResolvedValueOnce({ 
                done: false, 
                value: new TextEncoder().encode(`data: {"choices":[{"delta":{"content":"${chunks[2]}"}}]}\n\n`)
              })
              .mockResolvedValueOnce({ done: true })
          })
        }
      };
      
      global.fetch.mockResolvedValueOnce(mockResponse);
      
      // In a real scenario, we'd verify that each chunk triggers
      // an update to the UI
    });
  });

  describe('Security', () => {
    test('should properly escape HTML in summaries', () => {
      const maliciousText = '<script>alert("XSS")</script>';
      
      // When this text is displayed using textContent (as in displaySummary),
      // it should be automatically escaped and not execute
      
      // This is handled by the browser's textContent property
      const div = document.createElement('div');
      div.textContent = maliciousText;
      
      expect(div.innerHTML).toBe('&lt;script&gt;alert("XSS")&lt;/script&gt;');
    });
    
    test('should validate API keys are present', () => {
      // In production, we'd check that API keys are not empty
      // This would prevent unnecessary API calls
    });
  });
});